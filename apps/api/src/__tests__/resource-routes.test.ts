import { WorkerStatus } from '@taskflow/types';
import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  countActiveWorkersForQueue: vi.fn(),
  getQueueByName: vi.fn(),
  getQueueStats: vi.fn(),
  getWorkerById: vi.fn(),
  listQueues: vi.fn(),
  listWorkers: vi.fn(),
  recordOperationalAudit: vi.fn(),
  requestWorkerStop: vi.fn(),
  setQueueActive: vi.fn(),
}));
const queue = vi.hoisted(() => ({ getQueueDepth: vi.fn() }));

vi.mock('@taskflow/database', () => database);
vi.mock('@taskflow/queue', () => queue);

import { errorHandler } from '../middleware/error-handler';
import { queueRoutes } from '../routes/queues';
import { workerRoutes } from '../routes/workers';

const queueId = '20000000-0000-4000-8000-000000000001';
const workerId = '30000000-0000-4000-8000-000000000001';
const createdAt = new Date('2026-01-02T03:04:05.000Z');
const updatedAt = new Date('2026-01-03T03:04:05.000Z');

const queueRecord = {
  id: queueId,
  name: 'default',
  displayName: 'Default',
  description: 'Primary queue',
  priority: 5,
  concurrencyLimit: 10,
  maxRetryAttempts: 3,
  defaultTimeoutMs: 30_000,
  rateLimitPerMinute: null,
  isActive: true,
  createdAt,
  updatedAt,
};

const workerRecord = {
  id: workerId,
  workerName: 'worker-one',
  hostname: 'localhost',
  processId: 123,
  concurrency: 4,
  queues: ['default'],
  status: WorkerStatus.STOPPED,
  currentJobCount: 0,
  lastHeartbeatAt: updatedAt,
  startedAt: createdAt,
  stoppedAt: updatedAt,
  totalJobsProcessed: 10,
  totalJobsSucceeded: 8,
  totalJobsFailed: 2,
  version: '1.0.0',
  metadata: { region: 'local' },
};

const openApps: FastifyInstance[] = [];

async function createResourceApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', (request, _reply, done) => {
    request.user = {
      id: '10000000-0000-4000-8000-000000000001',
      email: 'operator@example.test',
      role: 'admin',
    };
    done();
  });
  await app.register(queueRoutes, { prefix: '/queues' });
  await app.register(workerRoutes, { prefix: '/workers' });
  openApps.push(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  database.getQueueByName.mockResolvedValue(queueRecord);
  database.getWorkerById.mockResolvedValue(workerRecord);
  database.listQueues.mockResolvedValue({ queues: [], total: 0 });
  database.listWorkers.mockResolvedValue({ workers: [], total: 0 });
  database.getQueueStats.mockResolvedValue(undefined);
  database.countActiveWorkersForQueue.mockResolvedValue(0);
  database.recordOperationalAudit.mockResolvedValue({});
  database.requestWorkerStop.mockResolvedValue({
    ...workerRecord,
    status: WorkerStatus.STOPPING,
    stoppedAt: null,
  });
  database.setQueueActive.mockImplementation(
    (_name: string, isActive: boolean) =>
      Promise.resolve({ ...queueRecord, isActive })
  );
  queue.getQueueDepth.mockResolvedValue(0);
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe('queue resource routes', () => {
  it('lists real repository rows with validated pagination and total', async () => {
    database.listQueues.mockResolvedValue({
      queues: [queueRecord],
      total: 7,
    });
    const app = await createResourceApp();

    const response = await app.inject({
      method: 'GET',
      url: '/queues?limit=1&offset=2',
    });

    expect(response.statusCode).toBe(200);
    expect(database.listQueues).toHaveBeenCalledWith({ limit: 1, offset: 2 });
    expect(response.json()).toEqual({
      data: [
        {
          id: queueId,
          name: 'default',
          displayName: 'Default',
          description: 'Primary queue',
          priority: 5,
          concurrencyLimit: 10,
          maxRetryAttempts: 3,
          defaultTimeoutMs: 30_000,
          rateLimitPerMinute: null,
          isActive: true,
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
      ],
      pagination: { limit: 1, offset: 2, total: 7 },
    });
  });

  it('uses validated queue names and reports the real active worker count', async () => {
    database.getQueueStats.mockResolvedValue({
      queueId,
      queued: '4',
      processing: '2',
      succeeded: '8',
      failed: '1',
      avgDurationMs: '12.5',
    });
    database.countActiveWorkersForQueue.mockResolvedValue(3);
    queue.getQueueDepth.mockResolvedValue(5);
    const app = await createResourceApp();

    const invalid = await app.inject({
      method: 'GET',
      url: '/queues/Upper_Case/stats',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/queues/default/stats',
    });

    expect(invalid.statusCode).toBe(400);
    expect(response.statusCode).toBe(200);
    expect(database.getQueueByName).toHaveBeenCalledTimes(1);
    expect(database.countActiveWorkersForQueue).toHaveBeenCalledWith('default');
    expect(response.json()).toMatchObject({
      queue: 'default',
      jobs: { queued: 4, processing: 2, succeeded: 8, failed: 1 },
      redis: { depth: 5 },
      workers: { active: 3 },
      performance: { avgDurationMs: 12.5 },
    });
  });

  it('validates pagination and persists queue controls', async () => {
    const app = await createResourceApp();

    const invalidPage = await app.inject({
      method: 'GET',
      url: '/queues?limit=101',
    });
    database.setQueueActive.mockResolvedValueOnce(undefined);
    const missing = await app.inject({
      method: 'POST',
      url: '/queues/missing/pause',
    });
    const existing = await app.inject({
      method: 'POST',
      url: '/queues/default/resume',
    });

    expect(invalidPage.statusCode).toBe(400);
    expect(database.listQueues).not.toHaveBeenCalled();
    expect(missing.statusCode).toBe(404);
    expect(existing.statusCode).toBe(200);
    expect(existing.json()).toMatchObject({ name: 'default', isActive: true });
  });
});

describe('worker resource routes', () => {
  it('passes a shared worker status to PostgreSQL and returns the filtered total', async () => {
    database.listWorkers.mockResolvedValue({
      workers: [workerRecord],
      total: 6,
    });
    const app = await createResourceApp();

    const response = await app.inject({
      method: 'GET',
      url: '/workers?status=STOPPED&limit=1&offset=3',
    });

    expect(response.statusCode).toBe(200);
    expect(database.listWorkers).toHaveBeenCalledWith({
      status: WorkerStatus.STOPPED,
      limit: 1,
      offset: 3,
    });
    expect(response.json()).toMatchObject({
      data: [
        {
          id: workerId,
          name: 'worker-one',
          status: WorkerStatus.STOPPED,
          totalJobsProcessed: 10,
          startedAt: createdAt.toISOString(),
          stoppedAt: updatedAt.toISOString(),
        },
      ],
      pagination: { limit: 1, offset: 3, total: 6 },
    });
  });

  it('rejects the retired IDLE value and malformed worker UUIDs', async () => {
    const app = await createResourceApp();

    const invalidStatus = await app.inject({
      method: 'GET',
      url: '/workers?status=IDLE',
    });
    const invalidId = await app.inject({
      method: 'GET',
      url: '/workers/not-a-uuid',
    });

    expect(invalidStatus.statusCode).toBe(400);
    expect(invalidId.statusCode).toBe(400);
    expect(database.listWorkers).not.toHaveBeenCalled();
    expect(database.getWorkerById).not.toHaveBeenCalled();
  });

  it('uses one serializer for worker details and real worker statistics', async () => {
    const app = await createResourceApp();

    const detail = await app.inject({
      method: 'GET',
      url: `/workers/${workerId}`,
    });
    const stats = await app.inject({
      method: 'GET',
      url: `/workers/${workerId}/stats`,
    });

    expect(detail.statusCode).toBe(200);
    expect(stats.statusCode).toBe(200);
    const detailBody = detail.json<Record<string, unknown>>();
    expect(stats.json()).toEqual({ ...detailBody, successRate: 0.8 });
  });

  it('persists a worker stop request', async () => {
    const app = await createResourceApp();

    database.requestWorkerStop.mockResolvedValueOnce(undefined);
    const missing = await app.inject({
      method: 'POST',
      url: '/workers/30000000-0000-4000-8000-000000000002/stop',
    });
    const existing = await app.inject({
      method: 'POST',
      url: `/workers/${workerId}/stop`,
    });

    expect(missing.statusCode).toBe(404);
    expect(existing.statusCode).toBe(202);
    expect(existing.json()).toMatchObject({
      id: workerId,
      status: WorkerStatus.STOPPING,
    });
  });
});
