import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseRedisJobMessage,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';

import { claimStaleMessages, consumeJobs } from '../consumer';
import { enqueueJob } from '../producer';
import {
  getConsumerName,
  getStreamKey,
  WORKER_CONSUMER_GROUP,
} from '../stream-names';

const redis = vi.hoisted(() => ({
  xadd: vi.fn(),
  xreadgroup: vi.fn(),
  xpending: vi.fn(),
  xclaim: vi.fn(),
}));

vi.mock('../redis-client', () => ({
  getRedisClient: () => redis,
}));

function envelope(overrides: Record<string, unknown> = {}) {
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
    expect(parseRedisJobMessage(JSON.parse(call?.[3] as string))).toMatchObject(
      {
        schemaVersion: REDIS_JOB_MESSAGE_VERSION,
        jobId: 'job-123',
        attempt: 2,
        queue: 'default',
      }
    );
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

  it('parses the nested entry tuples returned by ioredis XCLAIM', async () => {
    redis.xpending.mockResolvedValue([
      ['1003-0', 'worker:dead-worker', 30_001, 1],
    ]);
    redis.xclaim.mockResolvedValue([
      [
        '1003-0',
        [REDIS_JOB_MESSAGE_FIELD, JSON.stringify(envelope({ attempt: 2 }))],
      ],
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

    expect(redis.xclaim).toHaveBeenCalledWith(
      getStreamKey('default'),
      WORKER_CONSUMER_GROUP,
      getConsumerName('replacement'),
      30_000,
      '1003-0'
    );
  });
});
