import { createLogger } from '@taskflow/logger';
import {
  parseRedisJobMessage,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';
import type { RedisJobMessage } from '@taskflow/types';

import { getRedisClient } from './redis-client';
import { getStreamKey } from './stream-names';

const logger = createLogger({ component: 'QueueProducer' });

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
 * @param attempt - Attempt number (for retries)
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
    // Execute all commands atomically
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
      return messageId as string;
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
 * Trim stream to prevent unbounded growth
 *
 * Removes old acknowledged messages.
 */
export async function trimStream(
  queueName: string,
  maxLength: number = 100000
): Promise<number> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);

  try {
    // XTRIM with approximate trimming (more efficient)
    const trimmed = await redis.xtrim(streamKey, 'MAXLEN', '~', maxLength);

    if (trimmed > 0) {
      logger.info('Stream trimmed', {
        queue: queueName,
        trimmed,
        maxLength,
      });
    }

    return trimmed;
  } catch (error) {
    logger.error('Failed to trim stream', { queue: queueName, error });
    throw error;
  }
}
