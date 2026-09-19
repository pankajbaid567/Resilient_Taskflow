import { createLogger } from '@taskflow/logger';
import { parseRedisJobMessage, REDIS_JOB_MESSAGE_FIELD } from '@taskflow/types';
import type { RedisJobMessage } from '@taskflow/types';

import { quarantineEntry } from './quarantine';
import { getRedisClient } from './redis-client';
import {
  getConsumerName,
  getStreamKey,
  parseQueueFromStreamKey,
  WORKER_CONSUMER_GROUP,
} from './stream-names';

const logger = createLogger({ component: 'QueueConsumer' });

type RedisReadGroupResult = Array<
  [stream: string, entries: Array<[messageId: string, fields: string[]]>]
>;

/**
 * Consumed Message
 */
export interface ConsumedMessage {
  messageId: string;
  stream: string;
  queue: string;
  data: RedisJobMessage;
  /** Redis PEL delivery count. New deliveries start at one. */
  deliveryCount?: number;
}

export interface StaleClaimReport {
  messages: ConsumedMessage[];
  nextCursor: string;
  /**
   * IDs Redis removed from the PEL because their stream entries no longer
   * exist. The payload cannot be recovered from Redis; callers can use these
   * IDs for reconciliation and the consumer logs them as data-loss evidence.
   */
  deletedMessageIds: string[];
}

function getMessageDataField(fields: string[]): string {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === REDIS_JOB_MESSAGE_FIELD) {
      const value = fields[index + 1];
      if (value !== undefined) {
        return value;
      }
    }
  }

  throw new Error(
    `Redis stream entry is missing the ${REDIS_JOB_MESSAGE_FIELD} field`
  );
}

function parseConsumedMessage(
  stream: string,
  messageId: string,
  fields: string[]
): ConsumedMessage {
  const queue = parseQueueFromStreamKey(stream);
  if (!queue) {
    throw new Error(`Invalid TaskFlow job stream key: ${stream}`);
  }

  const serializedMessage = getMessageDataField(fields);
  const parsedMessage: unknown = JSON.parse(serializedMessage);
  const data = parseRedisJobMessage(parsedMessage);

  if (data.queue !== queue) {
    throw new Error(
      `Queue message ${messageId} targets ${data.queue}, but was read from ${queue}`
    );
  }

  return {
    messageId,
    stream,
    queue,
    data,
  };
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseClaimedEntry(stream: string, entry: unknown): ConsumedMessage {
  if (!isUnknownArray(entry) || entry.length !== 2) {
    throw new Error('Redis XCLAIM/XAUTOCLAIM returned an invalid stream entry');
  }

  const messageId = entry[0];
  const fields = entry[1];
  if (
    typeof messageId !== 'string' ||
    !isUnknownArray(fields) ||
    !fields.every((field): field is string => typeof field === 'string')
  ) {
    throw new Error('Redis XCLAIM/XAUTOCLAIM returned an invalid stream entry');
  }

  return parseConsumedMessage(stream, messageId, fields);
}

/**
 * Queue Consumer
 *
 * Consumes jobs from Redis Streams using consumer groups.
 */

/**
 * Consume jobs from multiple queues
 *
 * Uses XREADGROUP with blocking to wait for new messages.
 *
 * @param workerId - Unique worker identifier
 * @param queueNames - List of queues to consume from
 * @param options - Consumption options
 * @returns Array of consumed messages
 */
export async function consumeJobs(
  workerId: string,
  queueNames: string[],
  options: {
    batchSize?: number;
    blockMs?: number;
  } = {}
): Promise<ConsumedMessage[]> {
  const { batchSize = 10, blockMs = 5000 } = options;

  const redis = getRedisClient();
  const groupName = WORKER_CONSUMER_GROUP;
  const consumerName = getConsumerName(workerId);

  // Build XREADGROUP command
  const streams = queueNames.map(getStreamKey);
  const ids = queueNames.map(() => '>'); // '>' = only new messages

  try {
    const result = (await redis.xreadgroup(
      'GROUP',
      groupName,
      consumerName,
      'COUNT',
      batchSize,
      'BLOCK',
      blockMs,
      'STREAMS',
      ...streams,
      ...ids
    )) as RedisReadGroupResult | null;

    // No messages received (timeout)
    if (!result) {
      return [];
    }

    // Parse result into ConsumedMessage[]
    const messages: ConsumedMessage[] = [];

    for (const [streamKey, entries] of result) {
      for (const [messageId, fields] of entries) {
        messages.push({
          ...parseConsumedMessage(streamKey, messageId, fields),
          deliveryCount: 1,
        });
      }
    }

    if (messages.length > 0) {
      logger.debug('Jobs consumed', {
        workerId,
        count: messages.length,
        queues: queueNames,
      });
    }

    return messages;
  } catch (error) {
    logger.error('Failed to consume jobs', {
      workerId,
      queues: queueNames,
      error,
    });
    throw error;
  }
}

/**
 * Acknowledge message (mark as processed)
 */
export async function acknowledgeMessage(
  queueName: string,
  messageId: string
): Promise<boolean> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    const acknowledged = await redis.xack(streamKey, groupName, messageId);

    if (acknowledged === 0) {
      logger.warn('Message already acknowledged', {
        queue: queueName,
        messageId,
      });
      return false;
    }

    logger.debug('Message acknowledged', {
      queue: queueName,
      messageId,
    });

    return true;
  } catch (error) {
    logger.error('Failed to acknowledge message', {
      queue: queueName,
      messageId,
      error,
    });
    throw error;
  }
}

/**
 * Acknowledge multiple messages in batch
 */
export async function acknowledgeMessageBatch(
  queueName: string,
  messageIds: string[]
): Promise<number> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    const acknowledged = await redis.xack(streamKey, groupName, ...messageIds);

    logger.debug('Messages acknowledged', {
      queue: queueName,
      count: acknowledged,
    });

    return acknowledged;
  } catch (error) {
    logger.error('Failed to acknowledge message batch', {
      queue: queueName,
      count: messageIds.length,
      error,
    });
    throw error;
  }
}

/**
 * Get pending messages for a consumer (XPENDING summary or detail).
 *
 * NOTE: This function returns at most `count` entries and starts from the
 * beginning of the PEL. For exhaustive scanning use claimStaleMessages,
 * which uses cursor-based XAUTOCLAIM internally.
 */
export async function getPendingMessages(
  queueName: string,
  workerId?: string,
  count: number = 100
): Promise<
  Array<{
    messageId: string;
    consumerName: string;
    idleTimeMs: number;
    deliveryCount: number;
  }>
> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    let result;

    if (workerId) {
      // Get pending for specific consumer
      const consumerName = getConsumerName(workerId);
      result = await redis.xpending(
        streamKey,
        groupName,
        '-',
        '+',
        count,
        consumerName
      );
    } else {
      // Get all pending messages
      result = await redis.xpending(streamKey, groupName, '-', '+', count);
    }

    // Parse result
    const pending: Array<{
      messageId: string;
      consumerName: string;
      idleTimeMs: number;
      deliveryCount: number;
    }> = [];

    for (const entry of result as unknown[][]) {
      pending.push({
        messageId: entry[0] as string,
        consumerName: entry[1] as string,
        idleTimeMs: entry[2] as number,
        deliveryCount: entry[3] as number,
      });
    }

    return pending;
  } catch (error) {
    logger.error('Failed to get pending messages', {
      queue: queueName,
      workerId,
      error,
    });
    return [];
  }
}

const reclaimCursors = new Map<string, string>();

function getReclaimCursorKey(streamKey: string, consumerName: string): string {
  return `${streamKey}\u0000${consumerName}`;
}

/**
 * Reset in-memory reclaim cursor (e.g. on worker restart or for testing)
 */
export function resetReclaimCursor(
  queueName?: string,
  workerId?: string
): void {
  if (!queueName) {
    reclaimCursors.clear();
    return;
  }

  const streamKey = getStreamKey(queueName);
  if (workerId) {
    reclaimCursors.delete(
      getReclaimCursorKey(streamKey, getConsumerName(workerId))
    );
    return;
  }

  const prefix = `${streamKey}\u0000`;
  for (const cursorKey of reclaimCursors.keys()) {
    if (cursorKey.startsWith(prefix)) {
      reclaimCursors.delete(cursorKey);
    }
  }
}

function parseAutoClaimResult(rawResult: unknown): {
  nextCursor: string;
  entries: unknown[];
  deletedMessageIds: string[];
} {
  if (!isUnknownArray(rawResult) || rawResult.length < 2) {
    throw new Error('Redis XAUTOCLAIM returned an invalid response');
  }

  const [nextCursor, entries, rawDeletedMessageIds = []] = rawResult;
  if (
    typeof nextCursor !== 'string' ||
    !isUnknownArray(entries) ||
    !isUnknownArray(rawDeletedMessageIds) ||
    !rawDeletedMessageIds.every(
      (messageId): messageId is string => typeof messageId === 'string'
    )
  ) {
    throw new Error('Redis XAUTOCLAIM returned an invalid response');
  }

  return {
    nextCursor,
    entries,
    deletedMessageIds: rawDeletedMessageIds,
  };
}

async function getClaimedDeliveryCount(
  streamKey: string,
  consumerName: string,
  messageId: string
): Promise<number> {
  const redis = getRedisClient();
  const result = (await redis.xpending(
    streamKey,
    WORKER_CONSUMER_GROUP,
    messageId,
    messageId,
    1,
    consumerName
  )) as unknown;

  if (!isUnknownArray(result) || result.length !== 1) {
    throw new Error(
      `Claimed message ${streamKey}/${messageId} is no longer pending`
    );
  }

  const entry = result[0];
  if (
    !isUnknownArray(entry) ||
    entry[0] !== messageId ||
    entry[1] !== consumerName
  ) {
    throw new Error(
      `Redis XPENDING returned invalid ownership for ${streamKey}/${messageId}`
    );
  }

  const deliveryCount = Number(entry[3]);
  if (!Number.isSafeInteger(deliveryCount) || deliveryCount < 1) {
    throw new Error(
      `Redis XPENDING returned an invalid delivery count for ${streamKey}/${messageId}`
    );
  }

  return deliveryCount;
}

/**
 * Claim stale messages from dead/slow workers using cursor-based XAUTOCLAIM.
 *
 * XAUTOCLAIM is used instead of XPENDING+XCLAIM for two reasons:
 *
 *  1. **Exhaustive**: XPENDING returns at most N entries starting from the
 *     beginning of the PEL. XAUTOCLAIM uses a cursor so multiple calls
 *     eventually process every pending entry, even when the PEL has more than
 *     `limit` entries.
 *
 *  2. **Poison entry isolation**: Each claimed entry is parsed independently.
 *     A malformed envelope does not block subsequent valid entries — the
 *     poison entry is quarantined (XACK'd) and the rest are returned to the
 *     caller for processing.
 *
 * @param queueName     - Queue to scan
 * @param workerId      - Worker claiming ownership
 * @param minIdleTimeMs - Minimum idle time before an entry is reclaimable
 * @param limit         - Maximum entries to claim per call (default: 10)
 * @param cursor        - Optional explicit XAUTOCLAIM cursor
 * @returns Claimed messages
 */
export async function claimStaleMessages(
  queueName: string,
  workerId: string,
  minIdleTimeMs: number = 30_000,
  limit: number = 10,
  cursor?: string
): Promise<ConsumedMessage[]> {
  const report = await claimStaleMessagesWithReport(
    queueName,
    workerId,
    minIdleTimeMs,
    limit,
    cursor
  );
  return report.messages;
}

/**
 * Detailed XAUTOCLAIM result for recovery controllers that must reconcile
 * stream entries Redis reports as already deleted.
 */
export async function claimStaleMessagesWithReport(
  queueName: string,
  workerId: string,
  minIdleTimeMs: number = 30_000,
  limit: number = 10,
  cursor?: string
): Promise<StaleClaimReport> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;
  const consumerName = getConsumerName(workerId);
  const cursorKey = getReclaimCursorKey(streamKey, consumerName);
  const effectiveCursor = cursor ?? reclaimCursors.get(cursorKey) ?? '0-0';

  // XAUTOCLAIM <key> <group> <consumer> <min-idle-time> <start-id> [COUNT <n>]
  // Returns: [nextCursor, [[id, fields], ...], [deletedIds]]
  const rawResult: unknown = await redis.call(
    'XAUTOCLAIM',
    streamKey,
    groupName,
    consumerName,
    minIdleTimeMs,
    effectiveCursor,
    'COUNT',
    limit
  );

  const { nextCursor, entries, deletedMessageIds } =
    parseAutoClaimResult(rawResult);

  if (deletedMessageIds.length > 0) {
    logger.warn('XAUTOCLAIM removed missing stream entries from the PEL', {
      workerId,
      queue: queueName,
      stream: streamKey,
      deletedMessageIds,
      count: deletedMessageIds.length,
    });
  }

  const messages: ConsumedMessage[] = [];

  for (const entry of entries) {
    // Parse each entry independently — a poison entry must not block the rest.
    let message: ConsumedMessage;
    try {
      message = parseClaimedEntry(streamKey, entry);
    } catch (parseError) {
      // Quarantine: the entry is malformed or uses an unsupported schema.
      // XACK it so it leaves the PEL and does not stall recovery of healthy
      // entries. The entry is also recorded in the quarantine stream.
      const entryId =
        isUnknownArray(entry) && typeof entry[0] === 'string'
          ? entry[0]
          : '<unknown>';

      await quarantineEntry(
        streamKey,
        entryId,
        'MALFORMED_STREAM_ENTRY',
        {
          queue: queueName,
          error: String(parseError),
        },
        entry
      );
      continue;
    }

    messages.push({
      ...message,
      deliveryCount: await getClaimedDeliveryCount(
        streamKey,
        consumerName,
        message.messageId
      ),
    });
  }

  if (messages.length > 0) {
    logger.info('Stale messages claimed', {
      workerId,
      queue: queueName,
      count: messages.length,
      minIdleTimeMs,
    });
  }

  // Advance only after every claimed entry was either parsed or durably
  // quarantined. A quarantine persistence failure leaves the prior cursor in
  // place so the poison entry is revisited after its idle threshold elapses.
  reclaimCursors.set(cursorKey, nextCursor);

  return { messages, nextCursor, deletedMessageIds };
}

/**
 * Get pending message count for a queue
 */
export async function getPendingCount(queueName: string): Promise<number> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    const info = await redis.xpending(streamKey, groupName);

    // info[0] is the pending count
    return (info[0] as number) || 0;
  } catch (error) {
    logger.error('Failed to get pending count', { queue: queueName, error });
    return 0;
  }
}
