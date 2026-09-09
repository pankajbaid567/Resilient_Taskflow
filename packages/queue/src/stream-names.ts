/**
 * Stream Naming Conventions
 *
 * Consistent naming for Redis Streams and consumer groups.
 */

export const JOB_STREAM_PREFIX = 'taskflow:queue' as const;
export const JOB_STREAM_SUFFIX = 'jobs' as const;
export const WORKER_CONSUMER_GROUP = 'taskflow:workers' as const;
export const WORKER_CONSUMER_PREFIX = 'worker' as const;

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
  return match ? match[1] : null;
}
