/**
 * Integration Tests: Redis Queue Operations
 * Tests Redis Streams producer, consumer, and acknowledgement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTestRedis, TestRedis } from '../helpers/test-redis';
import { randomUUID } from 'crypto';
import { sleep, waitFor } from '../helpers/factories';

describe('Redis Queue Integration', () => {
  const queueName = 'test-queue';
  const streamKey = `taskflow:queue:${queueName}`;
  const groupName = 'taskflow-workers';

  describe('Stream Creation and Management', () => {
    it('should create stream on first message', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();
        const jobId = randomUUID();

        const messageId = await client.xadd(
          streamKey,
          '*',
          'jobId',
          jobId,
          'queue',
          queueName,
          'attempt',
          '1'
        );

        expect(messageId).toBeDefined();
        expect(typeof messageId).toBe('string');

        const length = await redis.getStreamLength(streamKey);
        expect(length).toBeGreaterThan(0);
      });
    });

    it('should get stream length correctly', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        // Add 5 messages
        for (let i = 0; i < 5; i++) {
          await client.xadd(
            streamKey,
            '*',
            'jobId',
            randomUUID(),
            'attempt',
            '1'
          );
        }

        const length = await redis.getStreamLength(streamKey);
        expect(length).toBe(5);
      });
    });

    it('should trim stream with MAXLEN', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        // Add 10 messages
        for (let i = 0; i < 10; i++) {
          await client.xadd(
            streamKey,
            '*',
            'jobId',
            randomUUID(),
            'attempt',
            '1'
          );
        }

        // Trim to 5 messages (approximately)
        await client.xtrim(streamKey, 'MAXLEN', '~', 5);

        const length = await redis.getStreamLength(streamKey);
        expect(length).toBeLessThanOrEqual(7); // ~5 allows some variance
      });
    });

    it('should delete stream', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());

        await redis.deleteStream(streamKey);

        const exists = await client.exists(streamKey);
        expect(exists).toBe(0);
      });
    });
  });

  describe('Consumer Groups', () => {
    it('should create consumer group', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        // Create stream first
        await client.xadd(streamKey, '*', 'jobId', randomUUID());

        // Create consumer group
        await redis.createConsumerGroup(streamKey, groupName);

        // Verify group exists by reading
        const result = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        expect(result).toBeDefined();
      });
    });

    it('should handle creating existing group gracefully', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());

        await redis.createConsumerGroup(streamKey, groupName);

        // Should not throw on second create
        await expect(
          redis.createConsumerGroup(streamKey, groupName)
        ).resolves.not.toThrow();
      });
    });

    it('should list consumers in group', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());
        await redis.createConsumerGroup(streamKey, groupName);

        // Read with consumer to register it
        await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        const consumers = await client.xinfo('CONSUMERS', streamKey, groupName);
        expect(Array.isArray(consumers)).toBe(true);
      });
    });
  });

  describe('Message Production', () => {
    it('should enqueue message with correct format', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();
        const jobId = randomUUID();

        const messageId = await client.xadd(
          streamKey,
          '*',
          'jobId',
          jobId,
          'queue',
          queueName,
          'attempt',
          '1',
          'createdAt',
          new Date().toISOString(),
          'schemaVersion',
          '1.0'
        );

        expect(messageId).toMatch(/^\d+-\d+$/);

        const messages = await redis.getStreamMessages(streamKey, 1);
        expect(messages.length).toBe(1);
        expect(messages[0][1]).toContain(jobId);
      });
    });

    it('should maintain message order', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();
        const jobIds = [randomUUID(), randomUUID(), randomUUID()];

        // Add in order
        for (const jobId of jobIds) {
          await client.xadd(streamKey, '*', 'jobId', jobId);
        }

        const messages = await redis.getStreamMessages(streamKey, 10);
        expect(messages.length).toBe(3);

        // Verify order by timestamp in message ID
        for (let i = 1; i < messages.length; i++) {
          const prevTimestamp = parseInt(messages[i - 1][0].split('-')[0]);
          const currTimestamp = parseInt(messages[i][0].split('-')[0]);
          expect(currTimestamp).toBeGreaterThanOrEqual(prevTimestamp);
        }
      });
    });

    it('should handle batch enqueuing', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();
        const pipeline = client.pipeline();

        for (let i = 0; i < 100; i++) {
          pipeline.xadd(streamKey, '*', 'jobId', randomUUID(), 'attempt', '1');
        }

        await pipeline.exec();

        const length = await redis.getStreamLength(streamKey);
        expect(length).toBe(100);
      });
    });
  });

  describe('Message Consumption', () => {
    beforeEach(async () => {
      // Setup: Create group for consumption tests
      await withTestRedis(async (redis) => {
        const client = redis.getClient();
        await client.xadd(streamKey, '*', 'jobId', randomUUID());
        await redis.createConsumerGroup(streamKey, groupName);
      });
    });

    it('should consume messages from group', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();
        const jobId = randomUUID();

        // Add message
        await client.xadd(streamKey, '*', 'jobId', jobId, 'attempt', '1');

        // Consume
        const result = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        expect(result).not.toBeNull();
        if (result) {
          expect(result[0][1].length).toBeGreaterThan(0);
        }
      });
    });

    it('should not consume already consumed messages', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());

        // First consume
        const result1 = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          10,
          'STREAMS',
          streamKey,
          '>'
        );

        // Second consume should return no new messages
        const result2 = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          10,
          'STREAMS',
          streamKey,
          '>'
        );

        expect(result1).not.toBeNull();
        expect(result2).toBeNull();
      });
    });

    it('should support blocking reads', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        // Start async blocking read
        const readPromise = client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'BLOCK',
          1000,
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        // Add message after short delay
        await sleep(100);
        await client.xadd(streamKey, '*', 'jobId', randomUUID());

        const result = await readPromise;
        expect(result).not.toBeNull();
      });
    });

    it('should handle concurrent consumers', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        // Add multiple messages
        for (let i = 0; i < 10; i++) {
          await client.xadd(streamKey, '*', 'jobId', randomUUID());
        }

        // Consume with multiple consumers
        const consumer1 = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          5,
          'STREAMS',
          streamKey,
          '>'
        );

        const consumer2 = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-2',
          'COUNT',
          5,
          'STREAMS',
          streamKey,
          '>'
        );

        // Both should get messages
        expect(consumer1).not.toBeNull();
        expect(consumer2).not.toBeNull();
      });
    });
  });

  describe('Message Acknowledgement', () => {
    it('should acknowledge consumed message', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());
        await redis.createConsumerGroup(streamKey, groupName);

        const result = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        if (result && result[0][1].length > 0) {
          const messageId = result[0][1][0][0];

          const ackResult = await client.xack(streamKey, groupName, messageId);
          expect(ackResult).toBe(1);
        }
      });
    });

    it('should track pending messages', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());
        await redis.createConsumerGroup(streamKey, groupName);

        // Consume without acknowledging
        await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        const pendingCount = await redis.getPendingCount(streamKey, groupName);
        expect(pendingCount).toBe(1);
      });
    });

    it('should remove from pending after acknowledgement', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());
        await redis.createConsumerGroup(streamKey, groupName);

        const result = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        if (result && result[0][1].length > 0) {
          const messageId = result[0][1][0][0];
          await client.xack(streamKey, groupName, messageId);

          const pendingCount = await redis.getPendingCount(
            streamKey,
            groupName
          );
          expect(pendingCount).toBe(0);
        }
      });
    });

    it('should handle batch acknowledgement', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        // Add multiple messages
        for (let i = 0; i < 5; i++) {
          await client.xadd(streamKey, '*', 'jobId', randomUUID());
        }

        await redis.createConsumerGroup(streamKey, groupName);

        const result = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          5,
          'STREAMS',
          streamKey,
          '>'
        );

        if (result && result[0][1].length > 0) {
          const messageIds = result[0][1].map((msg: any) => msg[0]);
          const ackResult = await client.xack(
            streamKey,
            groupName,
            ...messageIds
          );
          expect(ackResult).toBe(5);
        }
      });
    });
  });

  describe('Stale Message Recovery', () => {
    it('should claim idle pending messages', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();
        const jobId = randomUUID();

        await client.xadd(streamKey, '*', 'jobId', jobId);
        await redis.createConsumerGroup(streamKey, groupName);

        // Consumer 1 reads but doesn't ACK
        const result = await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        if (result && result[0][1].length > 0) {
          const messageId = result[0][1][0][0];

          // Wait a bit
          await sleep(100);

          // Consumer 2 claims the message
          const claimed = await client.xclaim(
            streamKey,
            groupName,
            'consumer-2',
            50, // Min idle time in ms
            messageId
          );

          expect(claimed.length).toBeGreaterThan(0);
        }
      });
    });

    it('should list pending messages with details', async () => {
      await withTestRedis(async (redis) => {
        const client = redis.getClient();

        await client.xadd(streamKey, '*', 'jobId', randomUUID());
        await redis.createConsumerGroup(streamKey, groupName);

        await client.xreadgroup(
          'GROUP',
          groupName,
          'consumer-1',
          'COUNT',
          1,
          'STREAMS',
          streamKey,
          '>'
        );

        const pending = await client.xpending(streamKey, groupName);
        expect(pending).toBeDefined();
        expect(pending[0]).toBeGreaterThan(0); // Pending count
      });
    });
  });
});
