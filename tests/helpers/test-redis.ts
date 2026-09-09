/**
 * Redis testing utilities
 * Provides helpers for managing test Redis state
 */

import Redis from 'ioredis';

export class TestRedis {
  private client?: Redis;

  async connect(url: string): Promise<void> {
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 50, 2000);
      },
    });

    await this.client.ping();
  }

  async flushAll(): Promise<void> {
    if (!this.client) {
      throw new Error('Redis not connected');
    }

    await this.client.flushall();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = undefined;
    }
  }

  getClient(): Redis {
    if (!this.client) {
      throw new Error('Redis not connected');
    }
    return this.client;
  }

  async getStreamLength(streamKey: string): Promise<number> {
    if (!this.client) {
      throw new Error('Redis not connected');
    }

    return await this.client.xlen(streamKey);
  }

  async getStreamMessages(streamKey: string, count: number = 10) {
    if (!this.client) {
      throw new Error('Redis not connected');
    }

    const result = await this.client.xrange(streamKey, '-', '+', 'COUNT', count);
    return result;
  }

  async getPendingCount(
    streamKey: string,
    groupName: string
  ): Promise<number> {
    if (!this.client) {
      throw new Error('Redis not connected');
    }

    const pending = await this.client.xpending(streamKey, groupName);
    return pending ? parseInt(pending[0] as string, 10) : 0;
  }

  async deleteStream(streamKey: string): Promise<void> {
    if (!this.client) {
      throw new Error('Redis not connected');
    }

    await this.client.del(streamKey);
  }

  async createConsumerGroup(
    streamKey: string,
    groupName: string
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Redis not connected');
    }

    try {
      await this.client.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
    } catch (error: any) {
      if (!error.message.includes('BUSYGROUP')) {
        throw error;
      }
    }
  }
}

/**
 * Create a test Redis instance
 */
export function createTestRedis(): TestRedis {
  return new TestRedis();
}

/**
 * Redis fixture for tests
 */
export async function withTestRedis<T>(
  fn: (redis: TestRedis) => Promise<T>
): Promise<T> {
  const testRedis = createTestRedis();

  try {
    const redisUrl = process.env.TEST_REDIS_URL || 'redis://localhost:6380';

    await testRedis.connect(redisUrl);
    await testRedis.flushAll();

    return await fn(testRedis);
  } finally {
    await testRedis.disconnect();
  }
}
