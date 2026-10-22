import { describe, expect, it, vi } from 'vitest';

import { consumeJobs } from '../consumer';

const clients = vi.hoisted(() => ({
  commands: { xreadgroup: vi.fn(), xadd: vi.fn() },
  blocking: { xreadgroup: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../redis-client', () => ({
  getRedisClient: () => clients.commands,
  getBlockingRedisClient: () => clients.blocking,
}));

describe('blocking reads', () => {
  // A blocking XREADGROUP on the shared connection holds back every other
  // command (the dispatcher's XADD, XACK) until the block times out. That made
  // an idle worker publish about 3 jobs/s, so the read must use its own client.
  it('use a dedicated connection, never the shared command client', async () => {
    await consumeJobs('worker-1', ['default'], { blockMs: 1 });

    expect(clients.blocking.xreadgroup).toHaveBeenCalledTimes(1);
    expect(clients.commands.xreadgroup).not.toHaveBeenCalled();
  });
});
