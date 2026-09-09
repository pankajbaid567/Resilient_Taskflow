import { createLogger } from '@taskflow/logger';

import { getRedisClient } from './redis-client';
import { getStreamKey, WORKER_CONSUMER_GROUP } from './stream-names';

const logger = createLogger({ component: 'ConsumerGroup' });

/**
 * Consumer Group Manager
 *
 * Manages Redis Streams consumer groups for distributed job processing.
 */

/**
 * Create consumer group for a queue
 *
 * Idempotent - won't error if group already exists.
 */
export async function createConsumerGroup(queueName: string): Promise<boolean> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    // XGROUP CREATE: Create consumer group
    // '0' = read from beginning of stream
    // MKSTREAM = create stream if it doesn't exist
    await redis.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');

    logger.info('Consumer group created', {
      queue: queueName,
      group: groupName,
    });

    return true;
  } catch (error) {
    // BUSYGROUP error means group already exists (OK)
    if (error instanceof Error && error.message.includes('BUSYGROUP')) {
      logger.debug('Consumer group already exists', {
        queue: queueName,
        group: groupName,
      });
      return false;
    }

    logger.error('Failed to create consumer group', {
      queue: queueName,
      error,
    });
    throw error;
  }
}

/**
 * Create consumer groups for multiple queues
 */
export async function createConsumerGroups(
  queueNames: string[]
): Promise<void> {
  await Promise.all(queueNames.map((queue) => createConsumerGroup(queue)));
}

/**
 * Delete consumer group
 *
 * Use with caution - destroys consumer group state.
 */
export async function deleteConsumerGroup(queueName: string): Promise<boolean> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    await redis.xgroup('DESTROY', streamKey, groupName);

    logger.warn('Consumer group deleted', {
      queue: queueName,
      group: groupName,
    });

    return true;
  } catch (error) {
    logger.error('Failed to delete consumer group', {
      queue: queueName,
      error,
    });
    return false;
  }
}

/**
 * Get consumer group info
 */
export async function getConsumerGroupInfo(queueName: string): Promise<{
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
} | null> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    const groups = (await redis.xinfo('GROUPS', streamKey)) as unknown[];

    // Find our group
    for (let i = 0; i < groups.length; i += 8) {
      const name = groups[i + 1] as string;

      if (name === groupName) {
        return {
          name,
          consumers: groups[i + 3] as number,
          pending: groups[i + 5] as number,
          lastDeliveredId: groups[i + 7] as string,
        };
      }
    }

    return null;
  } catch (error) {
    logger.error('Failed to get consumer group info', {
      queue: queueName,
      error,
    });
    return null;
  }
}

/**
 * Get all consumers in a group
 */
export async function getConsumers(queueName: string): Promise<
  Array<{
    name: string;
    pending: number;
    idle: number;
  }>
> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    const consumers = (await redis.xinfo(
      'CONSUMERS',
      streamKey,
      groupName
    )) as unknown[];

    const result: Array<{ name: string; pending: number; idle: number }> = [];

    // Parse consumer info (array of arrays)
    for (let i = 0; i < consumers.length; i += 6) {
      result.push({
        name: consumers[i + 1] as string,
        pending: consumers[i + 3] as number,
        idle: consumers[i + 5] as number,
      });
    }

    return result;
  } catch (error) {
    logger.error('Failed to get consumers', { queue: queueName, error });
    return [];
  }
}

/**
 * Delete a consumer from group
 *
 * Use when a worker has permanently stopped.
 */
export async function deleteConsumer(
  queueName: string,
  consumerName: string
): Promise<boolean> {
  const redis = getRedisClient();
  const streamKey = getStreamKey(queueName);
  const groupName = WORKER_CONSUMER_GROUP;

  try {
    const deleted = Number(
      await redis.xgroup('DELCONSUMER', streamKey, groupName, consumerName)
    );

    logger.info('Consumer deleted', {
      queue: queueName,
      consumer: consumerName,
      pendingMessages: deleted,
    });

    return deleted > 0;
  } catch (error) {
    logger.error('Failed to delete consumer', {
      queue: queueName,
      consumer: consumerName,
      error,
    });
    return false;
  }
}
