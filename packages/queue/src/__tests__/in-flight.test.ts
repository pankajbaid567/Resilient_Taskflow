import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getStreamInFlight } from '../producer';
import { getStreamKey, WORKER_CONSUMER_GROUP } from '../stream-names';

type RedisMockArguments = Array<string | number>;

const redis = vi.hoisted(() => ({
  xinfo: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xlen: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xrange: vi.fn<RedisMockArguments, Promise<unknown>>(),
}));

vi.mock('../redis-client', () => ({
  getRedisClient: () => redis,
}));

function groupInfo(fields: Record<string, unknown>): unknown[] {
  return Object.entries({ name: WORKER_CONSUMER_GROUP, ...fields }).flat();
}

describe('stream in-flight accounting', () => {
  const stream = getStreamKey('default');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is pending plus exact lag, ignoring acknowledged history', async () => {
    // XLEN would be 500 here; none of that history counts.
    redis.xlen.mockResolvedValue(500);
    redis.xinfo.mockResolvedValue([
      groupInfo({ pending: 3, lag: 4, 'last-delivered-id': '900-0' }),
    ]);

    await expect(getStreamInFlight('default', 100)).resolves.toBe(7);

    expect(redis.xinfo).toHaveBeenCalledWith('GROUPS', stream);
    expect(redis.xlen).not.toHaveBeenCalled();
    expect(redis.xrange).not.toHaveBeenCalled();
  });

  it('caps the result instead of reporting a huge backlog', async () => {
    redis.xinfo.mockResolvedValue([
      groupInfo({ pending: 40, lag: 10_000, 'last-delivered-id': '1-0' }),
    ]);

    await expect(getStreamInFlight('default', 200)).resolves.toBe(200);
  });

  it('short-circuits when the pending list alone fills the window', async () => {
    redis.xinfo.mockResolvedValue([
      groupInfo({ pending: 250, lag: 0, 'last-delivered-id': '1-0' }),
    ]);

    await expect(getStreamInFlight('default', 200)).resolves.toBe(200);
  });

  it('counts undelivered entries exactly, capped, when Redis reports lag as null', async () => {
    redis.xinfo.mockResolvedValue([
      groupInfo({ pending: 2, lag: null, 'last-delivered-id': '900-5' }),
    ]);
    redis.xrange.mockResolvedValue([
      ['901-0', []],
      ['902-0', []],
    ]);

    await expect(getStreamInFlight('default', 100)).resolves.toBe(4);

    // Exclusive range after the last delivered ID, bounded by the room left.
    expect(redis.xrange).toHaveBeenCalledWith(
      stream,
      '(900-5',
      '+',
      'COUNT',
      98
    );
    expect(redis.xlen).not.toHaveBeenCalled();
  });

  it('works on Redis versions that do not report lag at all', async () => {
    redis.xinfo.mockResolvedValue([
      groupInfo({ pending: 1, 'last-delivered-id': '10-0' }),
    ]);
    redis.xrange.mockResolvedValue([['11-0', []]]);

    await expect(getStreamInFlight('default', 50)).resolves.toBe(2);
  });

  it('treats a missing stream as empty', async () => {
    redis.xinfo.mockRejectedValue(new Error('ERR no such key'));

    await expect(getStreamInFlight('default', 100)).resolves.toBe(0);
  });

  it('treats a missing consumer group as an all-undelivered stream', async () => {
    redis.xinfo.mockResolvedValue([groupInfo({ name: 'some-other-group' })]);
    redis.xlen.mockResolvedValue(12);

    await expect(getStreamInFlight('default', 100)).resolves.toBe(12);
    await expect(getStreamInFlight('default', 5)).resolves.toBe(5);
  });

  it('propagates unexpected Redis failures instead of reporting an empty window', async () => {
    redis.xinfo.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(getStreamInFlight('default', 100)).rejects.toThrow(
      'ECONNREFUSED'
    );
  });

  it('rejects an invalid cap', async () => {
    await expect(getStreamInFlight('default', 0)).rejects.toThrow('cap');
  });
});
