import { randomUUID } from 'node:crypto';

import {
  acknowledgeMessage,
  closeRedisConnection,
  consumeJobs,
  createConsumerGroup,
  enqueueJob,
  getPendingMessages,
  getRedisClient,
  getStreamKey,
  WORKER_CONSUMER_GROUP,
} from '@taskflow/queue';
import {
  parseRedisJobMessage,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const queueName = `redis-integration-${process.pid}`;
const stream = getStreamKey(queueName);

beforeEach(async () => {
  const redis = getRedisClient();
  await redis.del(stream);
  await createConsumerGroup(queueName);
});

afterAll(async () => {
  const redis = getRedisClient();
  await redis.del(stream);
  await closeRedisConnection();
});

describe('Redis queue integration', () => {
  it('delivers the canonical envelope and keeps it pending until XACK', async () => {
    const jobId = randomUUID();
    const messageId = await enqueueJob(jobId, queueName, 1);

    const entries = await getRedisClient().xrange(stream, messageId, messageId);
    expect(entries).toHaveLength(1);
    const fields = entries[0]?.[1];
    expect(fields?.[0]).toBe(REDIS_JOB_MESSAGE_FIELD);
    const rawMessage = fields?.[1];
    expect(typeof rawMessage).toBe('string');
    const envelope = parseRedisJobMessage(JSON.parse(rawMessage as string));
    expect(envelope).toMatchObject({
      schemaVersion: REDIS_JOB_MESSAGE_VERSION,
      jobId,
      queue: queueName,
      attempt: 1,
    });

    const consumed = await consumeJobs('integration-consumer', [queueName], {
      batchSize: 1,
      blockMs: 100,
    });
    expect(consumed).toEqual([
      {
        messageId,
        stream,
        queue: queueName,
        data: envelope,
      },
    ]);

    const pending = await getPendingMessages(queueName);
    expect(pending).toEqual([
      expect.objectContaining({
        messageId,
        consumerName: 'worker:integration-consumer',
        deliveryCount: 1,
      }),
    ]);
    expect(
      await getRedisClient().xpending(stream, WORKER_CONSUMER_GROUP)
    ).toEqual(expect.arrayContaining([1]));

    await expect(acknowledgeMessage(queueName, messageId)).resolves.toBe(true);
    await expect(getPendingMessages(queueName)).resolves.toEqual([]);
  });
});
