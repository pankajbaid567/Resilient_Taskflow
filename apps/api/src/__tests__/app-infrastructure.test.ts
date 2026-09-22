import {
  cleanupExpiredIdempotencyKeys,
  findActiveUserByApiKey,
  getJobCounts,
  getQueueByName,
  getWorkerById,
} from '@taskflow/database';
import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taskflow/database', () => ({
  cleanupExpiredIdempotencyKeys: vi.fn().mockResolvedValue(0),
  findActiveUserByApiKey: vi.fn(),
  findActiveUserById: vi.fn(),
  countActiveWorkersForQueue: vi.fn(),
  cancelJob: vi.fn(),
  createJob: vi.fn(),
  createJobWithIdempotency: vi.fn(),
  getActiveWorkers: vi.fn(),
  getJobById: vi.fn(),
  getJobByIdempotencyKey: vi.fn(),
  getJobCounts: vi.fn(),
  getJobsByUserId: vi.fn(),
  getQueueByName: vi.fn(),
  getQueueStats: vi.fn(),
  getWorkerById: vi.fn(),
  listQueues: vi.fn(),
  listWorkers: vi.fn(),
  listOperationalAudit: vi.fn().mockResolvedValue({ records: [], total: 0 }),
  recordOperationalAudit: vi.fn(),
  requestWorkerStop: vi.fn(),
  setQueueActive: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock('@taskflow/queue', () => ({
  createRedisClient: vi.fn(() => ({
    eval: vi.fn().mockResolvedValue([1, 1, Date.now(), Date.now()]),
  })),
  testRedisConnection: vi.fn().mockResolvedValue(true),
}));

import {
  createApp,
  getJobRequestPolicy,
  shouldEnableSwagger,
  startServer,
} from '../app';
import { queueRoutes } from '../routes/queues';
import { workerRoutes } from '../routes/workers';

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  vi.useRealTimers();
});

describe('API route infrastructure policy', () => {
  it('keeps probe payloads minimal and admin-gates operational metrics', async () => {
    vi.mocked(findActiveUserByApiKey).mockImplementation((apiKey) => {
      if (apiKey === 'admin-key') {
        return Promise.resolve({
          id: '00000000-0000-4000-8000-000000000001',
          email: 'operator@example.com',
          role: 'admin',
        });
      }
      if (apiKey === 'user-key') {
        return Promise.resolve({
          id: '00000000-0000-4000-8000-000000000002',
          email: 'user@example.com',
          role: 'user',
        });
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(getJobCounts).mockResolvedValue({
      CREATED: 0,
      QUEUED: 0,
      PROCESSING: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      RETRY_SCHEDULED: 0,
      DEAD_LETTERED: 0,
      CANCEL_REQUESTED: 0,
      CANCELLED: 0,
    });
    const app = await createApp({ enableSwagger: false });
    openApps.push(app);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const anonymousMetrics = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    const userMetrics = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-api-key': 'user-key' },
    });
    const adminMetrics = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-api-key': 'admin-key' },
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'alive' });
    expect(anonymousMetrics.statusCode).toBe(401);
    expect(userMetrics.statusCode).toBe(403);
    expect(adminMetrics.statusCode).toBe(200);
    expect(adminMetrics.headers['content-type']).toContain('text/plain');
  });

  it('scopes submission/idempotency, read, and mutation policy by method and path', () => {
    expect(getJobRequestPolicy({ method: 'POST', url: '/api/v1/jobs' })).toBe(
      'job-submission'
    );
    expect(getJobRequestPolicy({ method: 'POST', url: '/api/v1/jobs/' })).toBe(
      'job-submission'
    );
    expect(
      getJobRequestPolicy({
        method: 'POST',
        url: '/api/v1/jobs/job-id/retry',
      })
    ).toBe('mutation');
    expect(
      getJobRequestPolicy({ method: 'DELETE', url: '/api/v1/jobs/job-id' })
    ).toBe('mutation');
    expect(
      getJobRequestPolicy({ method: 'GET', url: '/api/v1/jobs?limit=10' })
    ).toBe('read');
  });

  it('admin-gates queue mutation and worker control routes', async () => {
    const workerId = '30000000-0000-4000-8000-000000000001';
    vi.mocked(getQueueByName).mockResolvedValue({ id: 'queue-id' } as never);
    vi.mocked(getWorkerById).mockResolvedValue({ id: workerId } as never);
    const app = Fastify();
    app.addHook('onRequest', (request, _reply, done) => {
      request.user = {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'operator@example.com',
        role: request.headers['x-test-role'] === 'admin' ? 'admin' : 'user',
      };
      done();
    });
    await app.register(queueRoutes, { prefix: '/queues' });
    await app.register(workerRoutes, { prefix: '/workers' });
    openApps.push(app);

    const userResponses = await Promise.all([
      app.inject({ method: 'POST', url: '/queues/default/pause' }),
      app.inject({ method: 'POST', url: '/queues/default/resume' }),
      app.inject({ method: 'POST', url: `/workers/${workerId}/stop` }),
    ]);
    const adminResponses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/queues/default/pause',
        headers: { 'x-test-role': 'admin' },
      }),
      app.inject({
        method: 'POST',
        url: '/queues/default/resume',
        headers: { 'x-test-role': 'admin' },
      }),
      app.inject({
        method: 'POST',
        url: `/workers/${workerId}/stop`,
        headers: { 'x-test-role': 'admin' },
      }),
    ]);

    expect(userResponses.map(({ statusCode }) => statusCode)).toEqual([
      403, 403, 403,
    ]);
    // Authorized requests reach the persistence boundary; these mocks return
    // no record, so the resource handlers report not found.
    expect(adminResponses.map(({ statusCode }) => statusCode)).toEqual([
      404, 404, 404,
    ]);
  });

  it('disables interactive Swagger in production by default', async () => {
    expect(shouldEnableSwagger('production')).toBe(false);
    expect(shouldEnableSwagger('development')).toBe(true);
    expect(shouldEnableSwagger('production', true)).toBe(false);

    const app = await createApp({ enableSwagger: false });
    openApps.push(app);
    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(404);
  });

  it('runs and stops the expired idempotency-key cleanup schedule', async () => {
    vi.useFakeTimers();
    const cleanup = vi.mocked(cleanupExpiredIdempotencyKeys);
    cleanup.mockClear();
    const app = await createApp({
      enableSwagger: false,
      idempotencyCleanupIntervalMs: 10,
    });
    openApps.push(app);
    await app.ready();

    await vi.advanceTimersByTimeAsync(10);
    expect(cleanup).toHaveBeenCalledTimes(1);

    await app.close();
    await vi.advanceTimersByTimeAsync(20);
    expect(cleanup).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('startServer', () => {
  it('returns the listening app without taking process ownership', async () => {
    const listen = vi.fn().mockResolvedValue('http://127.0.0.1:4321');
    const close = vi.fn().mockResolvedValue(undefined);
    const app = { listen, close } as unknown as FastifyInstance;

    await expect(
      startServer({ app, host: '127.0.0.1', port: 4321 })
    ).resolves.toBe(app);
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 4321 });
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the app and propagates listen failure instead of exiting', async () => {
    const listenError = new Error('address already in use');
    const listen = vi.fn().mockRejectedValue(listenError);
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const app = { listen, close } as unknown as FastifyInstance;

    await expect(
      startServer({ app, host: '127.0.0.1', port: 4321 })
    ).rejects.toBe(listenError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
