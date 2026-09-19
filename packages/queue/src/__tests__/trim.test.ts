import { beforeEach, describe, expect, it, vi } from 'vitest';

import { trimStream } from '../producer';
import { getStreamKey, WORKER_CONSUMER_GROUP } from '../stream-names';

type RedisMockArguments = Array<string | number>;

const redis = vi.hoisted(() => ({
  xinfo: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xlen: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xpending: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xrevrange: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xtrim: vi.fn<RedisMockArguments, Promise<unknown>>(),
}));

vi.mock('../redis-client', () => ({
  getRedisClient: () => redis,
}));

describe('PEL and backlog-safe stream trimming', () => {
  const stream = getStreamKey('default');

  beforeEach(() => {
    vi.clearAllMocks();
    redis.xlen.mockResolvedValue(5);
    redis.xrevrange.mockResolvedValue([
      ['1004-0', ['data', '{}']],
      ['1003-0', ['data', '{}']],
    ]);
    redis.xtrim.mockResolvedValue(2);
  });

  it('never crosses the oldest pending entry', async () => {
    redis.xpending.mockResolvedValue([2, '1001-7', '1002-0', []]);
    redis.xinfo.mockResolvedValue([
      [
        'name',
        WORKER_CONSUMER_GROUP,
        'consumers',
        1,
        'pending',
        2,
        'last-delivered-id',
        '1002-0',
        'entries-read',
        3,
        'lag',
        2,
      ],
    ]);

    await expect(trimStream('default', 2)).resolves.toBe(2);

    expect(redis.xtrim).toHaveBeenCalledWith(stream, 'MINID', '1001-7');
    expect(redis.xinfo.mock.invocationCallOrder[0]).toBeLessThan(
      redis.xpending.mock.invocationCallOrder[0]!
    );
  });

  it('never deletes an undelivered backlog when the PEL is empty', async () => {
    redis.xpending.mockResolvedValue([0, null, null, []]);
    redis.xinfo.mockResolvedValue([
      [
        'name',
        WORKER_CONSUMER_GROUP,
        'consumers',
        0,
        'pending',
        0,
        'last-delivered-id',
        '1000-0',
        'entries-read',
        1,
        'lag',
        4,
      ],
    ]);

    await expect(trimStream('default', 2)).resolves.toBe(2);

    expect(redis.xtrim).toHaveBeenCalledWith(stream, 'MINID', '1000-0');
    expect(redis.xtrim).not.toHaveBeenCalledWith(
      stream,
      'MAXLEN',
      expect.anything(),
      expect.anything()
    );
  });

  it('does not trim a stream already within its configured retention', async () => {
    redis.xlen.mockResolvedValue(2);

    await expect(trimStream('default', 2)).resolves.toBe(0);

    expect(redis.xpending).not.toHaveBeenCalled();
    expect(redis.xtrim).not.toHaveBeenCalled();
  });
});
