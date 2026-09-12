import {
  parseRedisJobMessage,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { claimStaleMessages, consumeJobs } from '../consumer';
import { enqueueJob } from '../producer';
import {
  getConsumerName,
  getStreamKey,
  WORKER_CONSUMER_GROUP,
} from '../stream-names';

type RedisMockArguments = Array<string | number>;

const redis = vi.hoisted(() => ({
  call: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xadd: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xreadgroup: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xpending: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xclaim: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xack: vi.fn<RedisMockArguments, Promise<unknown>>(),
}));

vi.mock('../redis-client', () => ({
  getRedisClient: () => redis,
}));

function envelope(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: REDIS_JOB_MESSAGE_VERSION,
    jobId: 'job-123',
    enqueuedAt: '2026-09-08T10:00:00.000Z',
    attempt: 1,
    queue: 'default',
    ...overrides,
  };
}

describe('Redis job message contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts only the versioned v1 envelope', () => {
    expect(parseRedisJobMessage(envelope())).toEqual(envelope());

    expect(() =>
      parseRedisJobMessage(envelope({ schemaVersion: 2 }))
    ).toThrow();
    expect(() => parseRedisJobMessage(envelope({ attempt: 0 }))).toThrow();
    expect(() => parseRedisJobMessage(envelope({ queue: '' }))).toThrow();
    expect(() =>
      parseRedisJobMessage(envelope({ unexpected: true }))
    ).toThrow();
  });

  it('writes the validated envelope under the authoritative Redis field', async () => {
    redis.xadd.mockResolvedValue('1000-0');

    await expect(enqueueJob('job-123', 'default', 2)).resolves.toBe('1000-0');

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const call = redis.xadd.mock.calls[0];
    expect(call?.slice(0, 3)).toEqual([
      getStreamKey('default'),
      '*',
      REDIS_JOB_MESSAGE_FIELD,
    ]);
    const serializedMessage = call?.[3];
    expect(typeof serializedMessage).toBe('string');
    if (typeof serializedMessage !== 'string') {
      throw new Error('Expected XADD to receive a serialized message');
    }
    const parsedMessage: unknown = JSON.parse(serializedMessage);
    expect(parseRedisJobMessage(parsedMessage)).toMatchObject({
      schemaVersion: REDIS_JOB_MESSAGE_VERSION,
      jobId: 'job-123',
      attempt: 2,
      queue: 'default',
    });
  });

  it('rejects invalid producer input before writing to Redis', async () => {
    await expect(enqueueJob('job-123', 'default', 0)).rejects.toThrow();
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('finds and validates the data field without relying on field order', async () => {
    redis.xreadgroup.mockResolvedValue([
      [
        getStreamKey('default'),
        [
          [
            '1001-0',
            [
              'traceId',
              'trace-123',
              REDIS_JOB_MESSAGE_FIELD,
              JSON.stringify(envelope()),
            ],
          ],
        ],
      ],
    ]);

    await expect(
      consumeJobs('worker-1', ['default'], { batchSize: 1, blockMs: 1 })
    ).resolves.toEqual([
      {
        messageId: '1001-0',
        stream: getStreamKey('default'),
        queue: 'default',
        data: envelope(),
      },
    ]);

    expect(redis.xreadgroup).toHaveBeenCalledWith(
      'GROUP',
      WORKER_CONSUMER_GROUP,
      getConsumerName('worker-1'),
      'COUNT',
      1,
      'BLOCK',
      1,
      'STREAMS',
      getStreamKey('default'),
      '>'
    );
  });

  it('rejects an unsupported message version when consuming', async () => {
    redis.xreadgroup.mockResolvedValue([
      [
        getStreamKey('default'),
        [
          [
            '1002-0',
            [
              REDIS_JOB_MESSAGE_FIELD,
              JSON.stringify(envelope({ schemaVersion: 2 })),
            ],
          ],
        ],
      ],
    ]);

    await expect(consumeJobs('worker-1', ['default'])).rejects.toThrow();
  });

  it('parses the nested entry tuples returned by XAUTOCLAIM', async () => {
    redis.call.mockResolvedValue([
      '0-0',
      [
        [
          '1003-0',
          [REDIS_JOB_MESSAGE_FIELD, JSON.stringify(envelope({ attempt: 2 }))],
        ],
      ],
      [],
    ]);

    await expect(
      claimStaleMessages('default', 'replacement', 30_000, 1)
    ).resolves.toEqual([
      {
        messageId: '1003-0',
        stream: getStreamKey('default'),
        queue: 'default',
        data: envelope({ attempt: 2 }),
      },
    ]);

    expect(redis.call).toHaveBeenCalledWith(
      'XAUTOCLAIM',
      getStreamKey('default'),
      WORKER_CONSUMER_GROUP,
      getConsumerName('replacement'),
      30_000,
      '0-0',
      'COUNT',
      1
    );
  });

  it('quarantines poison messages during XAUTOCLAIM and returns valid messages', async () => {
    redis.call.mockResolvedValue([
      '1005-0',
      [
        ['1004-0', ['invalid_field', 'poison_value']],
        [
          '1005-0',
          [REDIS_JOB_MESSAGE_FIELD, JSON.stringify(envelope({ attempt: 1 }))],
        ],
      ],
      [],
    ]);
    redis.xadd.mockResolvedValue('quarantine-id');
    redis.xack.mockResolvedValue(1);

    const claimed = await claimStaleMessages('default', 'replacement', 30_000, 2);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.messageId).toBe('1005-0');
    expect(redis.xack).toHaveBeenCalledWith(
      getStreamKey('default'),
      WORKER_CONSUMER_GROUP,
      '1004-0'
    );
  });
});
