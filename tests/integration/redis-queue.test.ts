import { randomUUID } from 'node:crypto';

import {
  acknowledgeMessage,
  claimStaleMessages,
  claimStaleMessagesWithReport,
  closeRedisConnection,
  consumeJobs,
  createConsumerGroup,
  enqueueJob,
  getPendingMessages,
  getRedisClient,
  getStreamKey,
  resetReclaimCursor,
  trimStream,
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
  resetReclaimCursor();
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
        deliveryCount: 1,
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

  it('trims acknowledged history without deleting an undelivered backlog', async () => {
    const messageIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      messageIds.push(await enqueueJob(randomUUID(), queueName, 1));
    }

    const firstDelivery = await consumeJobs('trim-consumer', [queueName], {
      batchSize: 2,
      blockMs: 100,
    });
    expect(firstDelivery.map(({ messageId }) => messageId)).toEqual(
      messageIds.slice(0, 2)
    );
    await acknowledgeMessage(queueName, messageIds[0]!);
    await acknowledgeMessage(queueName, messageIds[1]!);

    await trimStream(queueName, 1);

    const remainingEntries = await getRedisClient().xrange(stream, '-', '+');
    expect(remainingEntries.map(([messageId]) => messageId)).toEqual(
      messageIds.slice(1)
    );

    const undelivered = await consumeJobs('trim-consumer', [queueName], {
      batchSize: 10,
      blockMs: 100,
    });
    expect(undelivered.map(({ messageId }) => messageId)).toEqual(
      messageIds.slice(2)
    );
  });

  it('reports Redis durable delivery attempts when a replacement reclaims work', async () => {
    const messageId = await enqueueJob(randomUUID(), queueName, 1);
    await consumeJobs('original-consumer', [queueName], {
      batchSize: 1,
      blockMs: 100,
    });

    const reclaimed = await claimStaleMessages(
      queueName,
      'replacement-consumer',
      0,
      1
    );

    expect(reclaimed).toEqual([
      expect.objectContaining({
        messageId,
        stream,
        queue: queueName,
        deliveryCount: 2,
      }),
    ]);
    expect(await getPendingMessages(queueName)).toEqual([
      expect.objectContaining({
        messageId,
        consumerName: 'worker:replacement-consumer',
        deliveryCount: 2,
      }),
    ]);
  });

  it('surfaces IDs XAUTOCLAIM removes after their stream entry is deleted', async () => {
    const messageId = await enqueueJob(randomUUID(), queueName, 1);
    await consumeJobs('original-consumer', [queueName], {
      batchSize: 1,
      blockMs: 100,
    });
    await getRedisClient().xdel(stream, messageId);

    const report = await claimStaleMessagesWithReport(
      queueName,
      'replacement-consumer',
      0,
      1
    );

    expect(report).toEqual({
      messages: [],
      nextCursor: '0-0',
      deletedMessageIds: [messageId],
    });
    expect(await getPendingMessages(queueName)).toEqual([]);
  });
});
