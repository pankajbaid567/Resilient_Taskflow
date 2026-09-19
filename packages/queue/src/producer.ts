import { createLogger } from '@taskflow/logger';
import {
  parseRedisJobMessage,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';
import type { RedisJobMessage } from '@taskflow/types';

import { getRedisClient } from './redis-client';
import { getStreamKey, WORKER_CONSUMER_GROUP } from './stream-names';

const logger = createLogger({ component: 'QueueProducer' });

function parseStreamId(value: unknown, label: string): [bigint, bigint] {
  if (typeof value !== 'string') {
    throw new Error(`${label} is not a Redis stream ID`);
  }

  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error(`${label} is not a Redis stream ID: ${value}`);
  }

  return [BigInt(match[1]), BigInt(match[2])];
}

function compareStreamIds(left: string, right: string): number {
  const [leftMs, leftSequence] = parseStreamId(left, 'left stream ID');
  const [rightMs, rightSequence] = parseStreamId(right, 'right stream ID');

  if (leftMs !== rightMs) {
    return leftMs < rightMs ? -1 : 1;
  }
  if (leftSequence === rightSequence) {
    return 0;
  }
  return leftSequence < rightSequence ? -1 : 1;
}

function readGroupField(group: unknown[], fieldName: string): unknown {
  for (let index = 0; index < group.length; index += 2) {
    if (group[index] === fieldName) {
      return group[index + 1];
    }
  }
  return undefined;
}

function findLastDeliveredId(rawGroups: unknown): string {
  if (!Array.isArray(rawGroups)) {
    throw new Error('Redis XINFO GROUPS returned an invalid response');
  }

  const groups: unknown[][] = rawGroups.every(Array.isArray)
    ? (rawGroups as unknown[][])
    : [rawGroups];
  const group = groups.find(
    (candidate) => readGroupField(candidate, 'name') === WORKER_CONSUMER_GROUP
  );
  const lastDeliveredId = group
    ? readGroupField(group, 'last-delivered-id')
    : undefined;

  if (typeof lastDeliveredId !== 'string') {
    throw new Error(
      `Redis consumer group ${WORKER_CONSUMER_GROUP} was not found`
    );
  }

  parseStreamId(lastDeliveredId, 'consumer-group last-delivered ID');
  return lastDeliveredId;
}

function getEntryId(entry: unknown, label: string): string {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
    throw new Error(`${label} did not contain a Redis stream ID`);
  }
  parseStreamId(entry[0], label);
  return entry[0];
}

function createJobMessage(
  jobId: string,
  queueName: string,
  attempt: number
): RedisJobMessage {
  return parseRedisJobMessage({
    schemaVersion: REDIS_JOB_MESSAGE_VERSION,
    jobId,
    enqueuedAt: new Date().toISOString(),
    attempt,
    queue: queueName,
  });
}

/**
 * Queue Producer
 *
 * Enqueues jobs to Redis Streams.
 */

/**
 * Enqueue a job to the specified queue
 *
 * @param jobId - Unique job identifier
 * @param queueName - Queue name
 * @param attempt - Producer-supplied delivery hint. It is not the
 * authoritative PostgreSQL execution-attempt count.
 * @returns Message ID from Redis
 */
export async function enqueueJob(
  jobId: string,
  queueName: string,
  attempt: number = 1
): Promise<string> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);

  const message = createJobMessage(jobId, queueName, attempt);

  try {
    // XADD: Add message to stream
    // '*' means auto-generate message ID
    const messageId = await redis.xadd(
      streamKey,
      '*',
      REDIS_JOB_MESSAGE_FIELD,
      JSON.stringify(message)
    );

    if (messageId === null) {
      throw new Error('Redis XADD did not return a message ID');
    }

    logger.debug('Job enqueued', {
      jobId,
      queue: queueName,
      messageId,
      attempt,
    });

    return messageId;
  } catch (error) {
    logger.error('Failed to enqueue job', {
      jobId,
      queue: queueName,
      error,
    });
    throw error;
  }
}

/**
 * Enqueue multiple jobs in a batch (using pipeline)
 *
 * More efficient than individual enqueues.
 */
export async function enqueueJobBatch(
  jobs: Array<{
    jobId: string;
    queueName: string;
    attempt?: number;
  }>
): Promise<string[]> {
  const redis = getRedisClient();
  const pipeline = redis.pipeline();

  // Add all XADD commands to pipeline
  jobs.forEach(({ jobId, queueName, attempt = 1 }) => {
    const streamKey = getStreamKey(queueName);
    const message = createJobMessage(jobId, queueName, attempt);

    pipeline.xadd(
      streamKey,
      '*',
      REDIS_JOB_MESSAGE_FIELD,
      JSON.stringify(message)
    );
  });

  try {
    // Execute all pipeline commands. NOTE: A Redis pipeline is NOT atomic—
    // it is a network efficiency optimization that batches commands into one
    // round trip. Partial failures are possible: if one XADD fails, the
    // others may have succeeded. Callers must handle partial results.
    const results = await pipeline.exec();

    if (!results) {
      throw new Error('Pipeline execution failed');
    }

    // Extract message IDs
    const messageIds = results.map((result) => {
      const [error, messageId] = result;
      if (error) {
        throw error;
      }
      if (typeof messageId !== 'string') {
        throw new Error('Redis XADD returned an invalid message ID');
      }
      return messageId;
    });

    logger.info('Job batch enqueued', { count: jobs.length });

    return messageIds;
  } catch (error) {
    logger.error('Failed to enqueue job batch', { count: jobs.length, error });
    throw error;
  }
}

/**
 * Get stream length (queue depth)
 */
export async function getQueueDepth(queueName: string): Promise<number> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);

  try {
    const length = await redis.xlen(streamKey);
    return length;
  } catch (error) {
    logger.error('Failed to get queue depth', { queue: queueName, error });
    throw error;
  }
}

/**
 * Trim stream to prevent unbounded growth.
 *
 * Safety: before trimming, we query the Pending Entry List (PEL) minimum
 * delivery ID. We never trim below that boundary so entries that are pending
 * acknowledgement cannot be silently removed from the stream history.
 *
 * @param queueName - Queue to trim
 * @param maxLength - Maximum number of entries to retain (approximate)
 */
export async function trimStream(
  queueName: string,
  maxLength: number = 100_000
): Promise<number> {
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) {
    throw new Error('maxLength must be a positive safe integer');
  }

  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    const streamLength = Number(await redis.xlen(streamKey));
    if (!Number.isSafeInteger(streamLength) || streamLength < 0) {
      throw new Error('Redis XLEN returned an invalid stream length');
    }
    if (streamLength <= maxLength) {
      return 0;
    }

    // Find the oldest entry that the retention target would keep. We combine
    // this with the delivery boundary below, retaining extra entries whenever
    // required to protect pending or not-yet-delivered work.
    const retainedEntries = (await redis.xrevrange(
      streamKey,
      '+',
      '-',
      'COUNT',
      maxLength
    )) as unknown[];
    if (retainedEntries.length < maxLength) {
      // The stream shrank concurrently; there is no longer evidence that it
      // exceeds the configured retention.
      return 0;
    }
    const retentionBoundary = getEntryId(
      retainedEntries[retainedEntries.length - 1],
      'Redis XREVRANGE retention boundary'
    );

    // Snapshot the group position before reading the PEL. With this order, a
    // concurrent XREADGROUP is safe: either XPENDING observes its claimed
    // entries, or their IDs are later than this last-delivered boundary.
    const groups = await redis.xinfo('GROUPS', streamKey);
    const lastDeliveredId = findLastDeliveredId(groups);

    // Query PEL summary to find the oldest unacknowledged delivery ID.
    // xpending(key, group) returns [count, minId, maxId, consumers].
    const pelSummary = (await redis.xpending(streamKey, groupName)) as
      [number, string | null, string | null, unknown] | null;

    if (!pelSummary || !Number.isSafeInteger(Number(pelSummary[0]))) {
      throw new Error('Redis XPENDING returned an invalid summary');
    }

    let deliveryBoundary: string;
    if (Number(pelSummary[0]) > 0) {
      if (!pelSummary[1]) {
        throw new Error('Redis XPENDING omitted its oldest pending ID');
      }
      parseStreamId(pelSummary[1], 'oldest pending ID');
      deliveryBoundary = pelSummary[1];
    } else {
      // An empty PEL does not mean the stream is fully consumed. Retain the
      // snapshotted last-delivered entry plus every later ID. If delivery
      // occurred after the snapshot, those entries have later IDs; if it
      // occurred before XPENDING, its oldest pending ID was observed above.
      deliveryBoundary = lastDeliveredId;
    }

    const safeTrimId =
      compareStreamIds(retentionBoundary, deliveryBoundary) <= 0
        ? retentionBoundary
        : deliveryBoundary;
    const trimmed = await redis.xtrim(streamKey, 'MINID', safeTrimId);

    if (trimmed > 0) {
      logger.info('Stream trimmed at safe delivery boundary', {
        queue: queueName,
        trimmed,
        maxLength,
        retentionBoundary,
        deliveryBoundary,
        safeTrimId,
      });
    }

    return trimmed;
  } catch (error) {
    logger.error('Failed to trim stream', { queue: queueName, error });
    throw error;
  }
}
