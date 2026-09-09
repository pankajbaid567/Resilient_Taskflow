import { createLogger } from '@taskflow/logger';
import { parseRedisJobMessage, REDIS_JOB_MESSAGE_FIELD } from '@taskflow/types';
import type { RedisJobMessage } from '@taskflow/types';

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
    throw new Error('Redis XCLAIM returned an invalid stream entry');
  }

  const messageId = entry[0];
  const fields = entry[1];
  if (
    typeof messageId !== 'string' ||
    !isUnknownArray(fields) ||
    !fields.every((field) => typeof field === 'string')
  ) {
    throw new Error('Redis XCLAIM returned an invalid stream entry');
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
        messages.push(parseConsumedMessage(streamKey, messageId, fields));
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
 * Get pending messages for a consumer
 *
 * Returns messages that were delivered but not acknowledged.
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

/**
 * Claim stale messages from dead/slow workers
 *
 * Transfers ownership of messages that have been idle too long.
 */
export async function claimStaleMessages(
  queueName: string,
  workerId: string,
  minIdleTimeMs: number = 30000,
  limit: number = 10
): Promise<ConsumedMessage[]> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;
  const consumerName = getConsumerName(workerId);

  try {
    // First, get stale pending messages
    const pending = await getPendingMessages(queueName, undefined, 100);

    const staleIds = pending
      .filter((p) => p.idleTimeMs > minIdleTimeMs)
      .slice(0, limit)
      .map((p) => p.messageId);

    if (staleIds.length === 0) {
      return [];
    }

    // Claim ownership of stale messages
    const claimed = await redis.xclaim(
      streamKey,
      groupName,
      consumerName,
      minIdleTimeMs,
      ...staleIds
    );

    // Parse claimed messages
    const messages: ConsumedMessage[] = [];

    for (const entry of claimed) {
      messages.push(parseClaimedEntry(streamKey, entry));
    }

    if (messages.length > 0) {
      logger.info('Stale messages claimed', {
        workerId,
        queue: queueName,
        count: messages.length,
        minIdleTimeMs,
      });
    }

    return messages;
  } catch (error) {
    logger.error('Failed to claim stale messages', {
      workerId,
      queue: queueName,
      error,
    });
    return [];
  }
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
