import { getMetrics } from '@taskflow/observability';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  publishSystemGauges,
  recordHttpRequest,
  recordJobSubmitted,
} from '../metrics';

async function sample(series: string): Promise<number | undefined> {
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.split(' ').pop());
}

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

describe('system gauges published from a database snapshot', () => {
  it('exposes per-queue status counts, backlog by priority, lag, DLQ and live workers', async () => {
    publishSystemGauges({
      jobs: [
        { queue: 'g1', status: 'QUEUED', count: 7 },
        { queue: 'g1', status: 'DEAD_LETTERED', count: 2 },
      ],
      backlog: [
        { queue: 'g1', priority: 'HIGH', depth: 3, oldestAgeSeconds: 12 },
        { queue: 'g1', priority: 'LOW', depth: 4, oldestAgeSeconds: 95 },
      ],
      // Two workers, each serving g1 AND another queue: per-queue counts
      // overlap, so the total must come from the distinct count.
      liveWorkers: [
        { queue: 'g1', workers: 2 },
        { queue: 'g1b', workers: 2 },
      ],
      liveWorkerTotal: 2,
    });

    expect(
      await sample('taskflow_jobs_current{status="QUEUED",queue="g1"}')
    ).toBe(7);
    expect(await sample('taskflow_dlq_depth{queue="g1"}')).toBe(2);
    expect(
      await sample('taskflow_queue_depth{queue="g1",priority="HIGH"}')
    ).toBe(3);
    expect(
      await sample('taskflow_queue_depth{queue="g1",priority="LOW"}')
    ).toBe(4);
    // Lag is the age of the oldest waiting job across priorities.
    expect(await sample('taskflow_queue_lag_seconds{queue="g1"}')).toBe(95);
    expect(await sample('taskflow_workers_active{queue="g1"}')).toBe(2);
    // Summing the per-queue gauge would say 4; there are only 2 workers.
    expect(await sample('taskflow_workers_live')).toBe(2);
  });

  it('shows every status as 0 for a queue that has jobs, so panels have no gaps', async () => {
    publishSystemGauges({
      jobs: [{ queue: 'g2', status: 'QUEUED', count: 1 }],
      backlog: [],
      liveWorkers: [],
      liveWorkerTotal: 0,
    });

    expect(
      await sample('taskflow_jobs_current{status="SUCCEEDED",queue="g2"}')
    ).toBe(0);
    expect(
      await sample('taskflow_jobs_current{status="CANCELLED",queue="g2"}')
    ).toBe(0);
  });

  it('drops a series once it is gone instead of keeping its last value', async () => {
    publishSystemGauges({
      jobs: [],
      backlog: [
        { queue: 'g3', priority: 'HIGH', depth: 5, oldestAgeSeconds: 1 },
      ],
      liveWorkers: [{ queue: 'g3', workers: 1 }],
      liveWorkerTotal: 1,
    });
    expect(
      await sample('taskflow_queue_depth{queue="g3",priority="HIGH"}')
    ).toBe(5);

    // The next scrape sees an empty backlog and no live workers.
    publishSystemGauges({
      jobs: [],
      backlog: [],
      liveWorkers: [],
      liveWorkerTotal: 0,
    });

    expect(
      await sample('taskflow_queue_depth{queue="g3",priority="HIGH"}')
    ).toBeUndefined();
    expect(
      await sample('taskflow_queue_lag_seconds{queue="g3"}')
    ).toBeUndefined();
    expect(await sample('taskflow_workers_active{queue="g3"}')).toBeUndefined();
  });
});

describe('request metrics', () => {
  async function appWithRecorder(): Promise<FastifyInstance> {
    const app = Fastify();
    app.addHook('onResponse', recordHttpRequest);
    app.get('/api/v1/jobs/:id', (_request, reply) => reply.send({ ok: true }));
    open.push(app);
    return app;
  }

  it('labels by route pattern, never by the concrete URL', async () => {
    const app = await appWithRecorder();

    await app.inject({
      method: 'GET',
      url: '/api/v1/jobs/aaaaaaaa-0000-4000-8000-000000000001',
    });
    await app.inject({
      method: 'GET',
      url: '/api/v1/jobs/bbbbbbbb-0000-4000-8000-000000000002',
    });

    expect(
      await sample(
        'taskflow_http_requests_total{method="GET",path="/api/v1/jobs/:id",status="200"}'
      )
    ).toBe(2);
    const text = await getMetrics();
    expect(text).not.toContain('aaaaaaaa-0000');
    expect(text).not.toContain('bbbbbbbb-0000');
  });

  it('collapses every unknown path into one series', async () => {
    const app = await appWithRecorder();

    await app.inject({ method: 'GET', url: '/scan/one' });
    await app.inject({ method: 'GET', url: '/scan/two' });

    expect(
      await sample(
        'taskflow_http_requests_total{method="GET",path="unmatched",status="404"}'
      )
    ).toBe(2);
    expect(await getMetrics()).not.toContain('/scan/one');
  });

  it('records a duration observation per request', async () => {
    const app = await appWithRecorder();

    await app.inject({
      method: 'GET',
      url: '/api/v1/jobs/cccccccc-0000-4000-8000-000000000003',
    });

    expect(
      (await sample(
        'taskflow_http_request_duration_seconds_count{method="GET",path="/api/v1/jobs/:id",status="200"}'
      )) ?? 0
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('job submission counter', () => {
  it('counts by queue and priority only, with no caller-controlled label', async () => {
    recordJobSubmitted('sub-q', 'CRITICAL');
    recordJobSubmitted('sub-q', 'CRITICAL');

    expect(
      await sample(
        'taskflow_jobs_submitted_total{queue="sub-q",priority="CRITICAL"}'
      )
    ).toBe(2);
  });
});
