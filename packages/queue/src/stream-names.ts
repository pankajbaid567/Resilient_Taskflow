/**
 * Stream Naming Conventions
 *
 * Consistent naming for Redis Streams and consumer groups.
 */

export const JOB_STREAM_PREFIX = 'taskflow:queue';
export const JOB_STREAM_SUFFIX = 'jobs';
export const WORKER_CONSUMER_GROUP = 'taskflow:workers';
export const WORKER_CONSUMER_PREFIX = 'worker';

/**
 * Generate stream key for a queue
 *
 * Format: taskflow:queue:{queueName}:jobs
 */
export function getStreamKey(queueName: string): string {
  return `${JOB_STREAM_PREFIX}:${queueName}:${JOB_STREAM_SUFFIX}`;
}

/**
 * Get consumer group name
 *
 * All workers join the same consumer group per queue.
 */
export function getConsumerGroupName(): string {
  return WORKER_CONSUMER_GROUP;
}

/**
 * Generate consumer name for a worker
 *
 * Format: worker:{workerId}
 */
export function getConsumerName(workerId: string): string {
  return `${WORKER_CONSUMER_PREFIX}:${workerId}`;
}

/**
 * Parse queue name from stream key
 */
export function parseQueueFromStreamKey(streamKey: string): string | null {
  const match = streamKey.match(
    new RegExp(`^${JOB_STREAM_PREFIX}:([^:]+):${JOB_STREAM_SUFFIX}$`)
  );
  return match?.[1] ?? null;
}
