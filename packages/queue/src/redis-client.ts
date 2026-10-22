import { redisConfig } from '@taskflow/config';
import { logger } from '@taskflow/logger';
import Redis from 'ioredis';

/**
 * Redis Client for Queue Operations
 *
 * Singleton Redis client with connection pooling and retry logic.
 */

let redisClient: Redis | null = null;
let blockingClient: Redis | null = null;

function createClient(label: string): Redis {
  const client = new Redis(redisConfig.url, {
    maxRetriesPerRequest: redisConfig.maxRetries,
    retryStrategy: (times: number) => {
      if (times > redisConfig.maxRetries) {
        logger.error('Redis max retries exceeded', {
          times,
          connection: label,
        });
        return null; // Stop retrying
      }
      const delay = Math.min(times * redisConfig.retryDelayMs, 5000);
      logger.warn('Redis connection retry', {
        attempt: times,
        delayMs: delay,
        connection: label,
      });
      return delay;
    },
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT'];
      return targetErrors.some((targetError) =>
        err.message.includes(targetError)
      );
    },
    enableReadyCheck: true,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
  client.on('connect', () => {
    logger.info('✓ Redis client connected', { connection: label });
  });
  client.on('ready', () => {
    logger.info('✓ Redis client ready', { connection: label });
  });
  client.on('error', (error) => {
    logger.error('Redis client error', { error, connection: label });
  });
  client.on('close', () => {
    logger.warn('Redis client connection closed', { connection: label });
  });
  client.on('reconnecting', (timeToReconnect?: number) => {
    logger.info('Redis client reconnecting', {
      timeToReconnect,
      connection: label,
    });
  });
  return client;
}

/**
 * Get or create the shared Redis client used for all non-blocking commands.
 */
export function getRedisClient(): Redis {
  redisClient ??= createClient('commands');
  return redisClient;
}

/**
 * A second connection reserved for blocking reads (XREADGROUP ... BLOCK).
 *
 * A Redis connection serves one command at a time, so a blocking read on the
 * shared client holds back every other command queued behind it, including the
 * dispatcher's XADD and the worker's XACK, until the block times out. With an
 * idle queue that capped dispatch at roughly one job per block interval
 * (about 3 jobs/s). Blocking reads therefore use their own connection.
 */
export function getBlockingRedisClient(): Redis {
  blockingClient ??= createClient('blocking');
  return blockingClient;
}

/**
 * Test Redis connection
 */
export async function testRedisConnection(): Promise<boolean> {
  try {
    const client = getRedisClient();
    await client.ping();

    logger.info('✓ Redis connection test successful');
    return true;
  } catch (error) {
    logger.error('✗ Redis connection test failed', { error });
    return false;
  }
}

/**
 * Close Redis connection
 */
export async function closeRedisConnection(): Promise<void> {
  const clients = [redisClient, blockingClient];
  redisClient = null;
  blockingClient = null;
  if (clients.some(Boolean)) {
    await Promise.all(
      clients.map(async (client) => {
        if (client) await client.quit();
      })
    );
    logger.info('Redis connection closed');
  }
}

/**
 * Alias for getRedisClient for consistency with API usage
 */
export const createRedisClient = getRedisClient;

/**
 * Initialize Redis connection
 */
export async function initRedis(): Promise<void> {
  const isConnected = await testRedisConnection();
  if (!isConnected) {
    throw new Error('Failed to connect to Redis');
  }
}
