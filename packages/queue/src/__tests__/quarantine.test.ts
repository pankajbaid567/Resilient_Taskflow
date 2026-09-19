import { beforeEach, describe, expect, it, vi } from 'vitest';

import { quarantineEntry } from '../quarantine';
import { getStreamKey, WORKER_CONSUMER_GROUP } from '../stream-names';

type RedisMockArguments = Array<string | number>;

const redis = vi.hoisted(() => ({
  xadd: vi.fn<RedisMockArguments, Promise<unknown>>(),
  xack: vi.fn<RedisMockArguments, Promise<unknown>>(),
}));

vi.mock('../redis-client', () => ({
  getRedisClient: () => redis,
}));

describe('quarantine persistence ordering', () => {
  const stream = getStreamKey('default');
  const rawEntry = ['1000-0', ['unexpected', 'payload']];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not acknowledge the source entry when quarantine persistence fails', async () => {
    redis.xadd.mockRejectedValue(new Error('quarantine unavailable'));

    await expect(
      quarantineEntry(
        stream,
        '1000-0',
        'MALFORMED_STREAM_ENTRY',
        { queue: 'default' },
        rawEntry
      )
    ).rejects.toThrow('quarantine unavailable');

    expect(redis.xack).not.toHaveBeenCalled();
  });

  it('preserves the raw source entry before acknowledging it', async () => {
    redis.xadd.mockResolvedValue('2000-0');
    redis.xack.mockResolvedValue(1);

    await quarantineEntry(
      stream,
      '1000-0',
      'MALFORMED_STREAM_ENTRY',
      { queue: 'default' },
      rawEntry
    );

    expect(redis.xadd).toHaveBeenCalledWith(
      `${stream}:quarantine`,
      '*',
      'messageId',
      '1000-0',
      'originalStream',
      stream,
      'reason',
      'MALFORMED_STREAM_ENTRY',
      'quarantinedAt',
      expect.any(String),
      'metadata',
      JSON.stringify({ queue: 'default' }),
      'rawEntry',
      JSON.stringify(rawEntry)
    );
    expect(redis.xack).toHaveBeenCalledWith(
      stream,
      WORKER_CONSUMER_GROUP,
      '1000-0'
    );
    expect(redis.xadd.mock.invocationCallOrder[0]).toBeLessThan(
      redis.xack.mock.invocationCallOrder[0]!
    );
  });

  it('does not acknowledge when XADD returns no quarantine entry ID', async () => {
    redis.xadd.mockResolvedValue(null);

    await expect(
      quarantineEntry(stream, '1000-0', 'MALFORMED_STREAM_ENTRY')
    ).rejects.toThrow('did not return a message ID');
    expect(redis.xack).not.toHaveBeenCalled();
  });
});
