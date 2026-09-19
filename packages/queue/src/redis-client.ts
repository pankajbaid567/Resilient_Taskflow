import { redisConfig } from '@taskflow/config';
import { logger } from '@taskflow/logger';
import Redis, { ChainableCommander } from 'ioredis';

/**
 * Redis Client for Queue Operations
 *
 * Singleton Redis client with connection pooling and retry logic.
 */

let redisClient: Redis | null = null;

/**
 * Get or create Redis client instance
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(redisConfig.url, {
      maxRetriesPerRequest: redisConfig.maxRetries,
      retryStrategy: (times: number) => {
        if (times > redisConfig.maxRetries) {
          logger.error('Redis max retries exceeded', { times });
          return null; // Stop retrying
        }

        const delay = Math.min(times * redisConfig.retryDelayMs, 5000);
        logger.warn('Redis connection retry', {
          attempt: times,
          delayMs: delay,
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

    // Event handlers
    redisClient.on('connect', () => {
      logger.info('✓ Redis client connected');
    });

    redisClient.on('ready', () => {
      logger.info('✓ Redis client ready');
    });

    redisClient.on('error', (error) => {
      logger.error('Redis client error', { error });
    });

    redisClient.on('close', () => {
      logger.warn('Redis client connection closed');
    });

    redisClient.on('reconnecting', (timeToReconnect?: number) => {
      logger.info('Redis client reconnecting', { timeToReconnect });
    });
  }

  return redisClient;
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
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}

/**
 * Execute Redis pipeline for batched operations
 */
export function createPipeline(): ChainableCommander {
  return getRedisClient().pipeline();
}

/**
 * Execute Redis transaction (MULTI/EXEC)
 */
export function createTransaction(): ChainableCommander {
  return getRedisClient().multi();
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
