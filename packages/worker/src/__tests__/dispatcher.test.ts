import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taskflow/database', () => ({
  claimPendingDeliveries: vi.fn(),
  getStaleDeliveries: vi.fn(),
  markDeliveryPublished: vi.fn(),
  renewDeliveryClaim: vi.fn(),
  releaseDeliveryForRetry: vi.fn(),
  resetDeliveryToPending: vi.fn(),
}));

const xrange = vi.fn();
const xinfo = vi.fn();
const xpending = vi.fn();

vi.mock('@taskflow/queue', () => ({
  enqueueJob: vi.fn(),
  getRedisClient: () => ({ xrange, xinfo, xpending }),
  getStreamKey: (queue: string) => `taskflow:queue:${queue}:jobs`,
  WORKER_CONSUMER_GROUP: 'taskflow:workers',
}));

vi.mock('@taskflow/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  claimPendingDeliveries,
  getStaleDeliveries,
  markDeliveryPublished,
  renewDeliveryClaim,
  releaseDeliveryForRetry,
  resetDeliveryToPending,
} from '@taskflow/database';
import { enqueueJob } from '@taskflow/queue';

import { Dispatcher } from '../dispatcher';

const delivery = {
  id: 'delivery-1',
  jobId: 'job-1',
  queueName: 'default',
  attempt: 1,
  availableAt: new Date(),
  status: 'PENDING',
  redisMessageId: null,
  publishedAt: null,
  claimedBy: 'dispatcher-a',
  claimedAt: new Date(),
  error: null,
  retryCount: 2,
  createdAt: new Date(),
};

describe('Dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStaleDeliveries).mockResolvedValue([]);
    vi.mocked(claimPendingDeliveries).mockResolvedValue([]);
    vi.mocked(markDeliveryPublished).mockResolvedValue(true);
    vi.mocked(renewDeliveryClaim).mockResolvedValue(true);
    vi.mocked(releaseDeliveryForRetry).mockResolvedValue(true);
    vi.mocked(resetDeliveryToPending).mockResolvedValue(true);
    xrange.mockResolvedValue([]);
    xinfo.mockResolvedValue([
      ['name', 'taskflow:workers', 'last-delivered-id', '0-0'],
    ]);
    xpending.mockResolvedValue([]);
  });

  it('publishes under a durable owner fence and finalizes that same claim', async () => {
    vi.mocked(claimPendingDeliveries).mockResolvedValue([delivery]);
    vi.mocked(enqueueJob).mockResolvedValue('123-0');

    const dispatcher = new Dispatcher({
      dispatcherId: 'dispatcher-a',
      claimTimeoutMs: 45_000,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    expect(claimPendingDeliveries).toHaveBeenCalledWith(
      'dispatcher-a',
      50,
      45_000
    );
    expect(enqueueJob).toHaveBeenCalledWith('job-1', 'default', 1);
    expect(renewDeliveryClaim).toHaveBeenCalledWith(
      'delivery-1',
      'dispatcher-a'
    );
    expect(markDeliveryPublished).toHaveBeenCalledWith(
      'delivery-1',
      'dispatcher-a',
      '123-0'
    );
  });

  it('keeps a delivery PENDING and retryable after bounded Redis exhaustion', async () => {
    vi.mocked(claimPendingDeliveries).mockResolvedValue([delivery]);
    vi.mocked(enqueueJob).mockRejectedValue(new Error('Redis unavailable'));

    const dispatcher = new Dispatcher({
      dispatcherId: 'dispatcher-a',
      maxRedisRetries: 1,
      retryBaseDelayMs: 0,
      enableStaleRepublish: false,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(0);

    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(releaseDeliveryForRetry).toHaveBeenCalledWith(
      'delivery-1',
      'dispatcher-a',
      'Redis unavailable',
      4
    );
    expect(markDeliveryPublished).not.toHaveBeenCalled();
    expect(dispatcher.getStats().deliveriesRetried).toBe(1);
  });

  it('does not finalize a Redis publication after losing the database claim', async () => {
    vi.mocked(claimPendingDeliveries).mockResolvedValue([delivery]);
    vi.mocked(enqueueJob).mockResolvedValue('123-0');
    vi.mocked(markDeliveryPublished).mockResolvedValue(false);

    const dispatcher = new Dispatcher({
      dispatcherId: 'dispatcher-a',
      enableStaleRepublish: false,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(0);
    expect(dispatcher.getStats().deliveriesPublished).toBe(0);
  });

  it('does not publish a batch row whose claim expired while earlier rows ran', async () => {
    vi.mocked(claimPendingDeliveries).mockResolvedValue([delivery]);
    vi.mocked(renewDeliveryClaim).mockResolvedValue(false);

    const dispatcher = new Dispatcher({
      dispatcherId: 'dispatcher-a',
      enableStaleRepublish: false,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(0);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(markDeliveryPublished).not.toHaveBeenCalled();
  });

  it('republishes only when the recorded Redis entry is actually absent', async () => {
    const published = {
      ...delivery,
      status: 'PUBLISHED',
      redisMessageId: '123-0',
      publishedAt: new Date(0),
      claimedBy: null,
      claimedAt: null,
    };
    vi.mocked(getStaleDeliveries).mockResolvedValue([
      { delivery: published, queueName: 'default', attempt: 1 },
    ]);
    xrange.mockResolvedValueOnce([['123-0', ['data', '{}']]]);

    const dispatcher = new Dispatcher({ dispatcherId: 'dispatcher-a' });
    await dispatcher.dispatchOnce();

    expect(xrange).toHaveBeenCalledWith(
      'taskflow:queue:default:jobs',
      '123-0',
      '123-0',
      'COUNT',
      1
    );
    expect(resetDeliveryToPending).not.toHaveBeenCalled();

    xrange.mockResolvedValueOnce([]);
    await dispatcher.dispatchOnce();
    expect(resetDeliveryToPending).toHaveBeenCalledWith('delivery-1');
    expect(dispatcher.getStats().staleRepublished).toBe(1);
  });

  it('republishes a physically present entry already acknowledged by the group', async () => {
    const published = {
      ...delivery,
      status: 'PUBLISHED',
      redisMessageId: '123-0',
      publishedAt: new Date(0),
      claimedBy: null,
      claimedAt: null,
    };
    vi.mocked(getStaleDeliveries).mockResolvedValue([
      { delivery: published, queueName: 'default', attempt: 1 },
    ]);
    xrange.mockResolvedValue([['123-0', ['data', '{}']]]);
    xinfo.mockResolvedValue([
      ['name', 'taskflow:workers', 'last-delivered-id', '123-0'],
    ]);
    xpending.mockResolvedValue([]);

    const dispatcher = new Dispatcher({ dispatcherId: 'dispatcher-a' });
    await dispatcher.dispatchOnce();

    expect(resetDeliveryToPending).toHaveBeenCalledWith('delivery-1');
  });

  it('rotates the stale scan cursor so a full first page cannot starve later rows', async () => {
    const publishedAt = new Date(0);
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      delivery: {
        ...delivery,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        status: 'PUBLISHED',
        redisMessageId: `${index + 1}-0`,
        publishedAt,
        claimedBy: null,
        claimedAt: null,
      },
      queueName: 'default',
      attempt: 1,
    }));
    const finalDelivery = {
      ...delivery,
      id: '00000000-0000-4000-8000-999999999999',
      status: 'PUBLISHED',
      redisMessageId: '999-0',
      publishedAt,
      claimedBy: null,
      claimedAt: null,
    };
    vi.mocked(getStaleDeliveries)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        { delivery: finalDelivery, queueName: 'default', attempt: 1 },
      ]);
    xrange.mockImplementation(async (_stream: string, messageId: string) =>
      messageId === '999-0' ? [] : [[messageId, ['data', '{}']]]
    );

    const dispatcher = new Dispatcher({ dispatcherId: 'dispatcher-a' });
    await dispatcher.dispatchOnce();
    await dispatcher.dispatchOnce();

    expect(getStaleDeliveries).toHaveBeenNthCalledWith(2, 120_000, 50, {
      deliveryId: firstPage[49]!.delivery.id,
    });
    expect(resetDeliveryToPending).toHaveBeenCalledWith(finalDelivery.id);
  });
});
