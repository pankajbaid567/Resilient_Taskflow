import { PermanentJobError } from '@taskflow/retry';
import { JobStatus } from '@taskflow/types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeConnection, sql } from '../client';
import {
  findActiveUserByApiKey,
  hashApiKey,
} from '../repositories/auth.repository';
import {
  acquireJobForDelivery,
  completeJobDelivery,
  failJobDelivery,
  JobCancellationRequestedError,
  releaseJobDelivery,
  renewJobDeliveryLease,
  startJobAttempt,
} from '../repositories/delivery.repository';
import {
  claimPendingDeliveries,
  getStaleDeliveries,
} from '../repositories/dispatch.repository';
import {
  createJob,
  createJobWithIdempotency,
  getJobCounts,
  IdempotencyConflictError,
  promoteDueScheduledJobs,
} from '../repositories/job.repository';
import { getMetricsSnapshot } from '../repositories/metrics.repository';

const runIntegration =
  process.env.TASKFLOW_DATABASE_INTEGRATION === 'true'
    ? describe
    : describe.skip;

const userId = '10000000-0000-4000-8000-000000000001';
const queueId = '20000000-0000-4000-8000-000000000001';
const workerOneId = '30000000-0000-4000-8000-000000000001';
const workerTwoId = '30000000-0000-4000-8000-000000000002';

async function createQueuedJob(maxAttempts = 3): ReturnType<typeof createJob> {
  return createJob({
    userId,
    queueId,
    type: 'persistence-contract-test',
    payload: { local: true },
    maxAttempts,
  });
}

runIntegration.sequential('delivery repository PostgreSQL contract', () => {
  beforeEach(async () => {
    await sql`TRUNCATE TABLE users, queues, workers, jobs CASCADE`;
    await sql`
      INSERT INTO users (id, email, password_hash)
      VALUES (${userId}, 'persistence-contract@example.test', 'test-only')
    `;
    await sql`
      INSERT INTO queues (id, name, display_name)
      VALUES (${queueId}, 'default', 'Default')
    `;
    await sql`
      INSERT INTO workers (id, worker_name, hostname, process_id, queues, status)
      VALUES
        (${workerOneId}, 'worker-one', 'localhost', 1, ARRAY['default'], 'ACTIVE'),
        (${workerTwoId}, 'worker-two', 'localhost', 2, ARRAY['default'], 'ACTIVE')
    `;
  });

  afterAll(closeConnection);

  it('persists a contiguous event order through successful delivery', async () => {
    const created = await createQueuedJob();
    expect(created).toMatchObject({
      status: JobStatus.QUEUED,
      attempts: 0,
      eventSequence: 2,
    });

    const acquired = await acquireJobForDelivery(
      created.id,
      workerOneId,
      5_000
    );
    expect(acquired.kind).toBe('ACQUIRED');
    if (acquired.kind !== 'ACQUIRED') return;

    await startJobAttempt(created.id, workerOneId, acquired.job.leaseId!);
    const renewed = await renewJobDeliveryLease(
      created.id,
      workerOneId,
      acquired.job.leaseId!,
      5_000
    );
    expect(renewed).not.toBeNull();
    const completed = await completeJobDelivery(
      created.id,
      workerOneId,
      acquired.job.leaseId!,
      { durable: true }
    );
    expect(completed.status).toBe(JobStatus.SUCCEEDED);

    const events = await sql<
      Array<{ event_type: string; event_sequence: number }>
    >`
      SELECT event_type, event_sequence
      FROM job_events
      WHERE job_id = ${created.id}
      ORDER BY event_sequence
    `;
    // Lease renewal is a heartbeat, not a lifecycle event.
    expect(events.map((event) => event.event_sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(events.map((event) => event.event_type)).toEqual([
      'created',
      'queued',
      'lease_acquired',
      'attempt_started',
      'completed',
    ]);

    const [attempt] = await sql<Array<{ status: string; duration_ms: number }>>`
      SELECT status, duration_ms
      FROM job_attempts
      WHERE job_id = ${created.id} AND attempt_number = 1
    `;
    expect(attempt?.status).toBe(JobStatus.SUCCEEDED);
    expect(attempt?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not lease a queued job after its attempt budget is exhausted', async () => {
    const created = await createQueuedJob(1);
    await sql`UPDATE jobs SET attempts = max_attempts WHERE id = ${created.id}`;

    const outcome = await acquireJobForDelivery(created.id, workerOneId, 5_000);
    expect(outcome.kind).toBe('NOT_READY');

    const [persisted] = await sql<Array<{ status: string; attempts: number }>>`
      SELECT status, attempts FROM jobs WHERE id = ${created.id}
    `;
    expect(persisted).toEqual({ status: JobStatus.QUEUED, attempts: 1 });
  });

  it('reports counts with the shared canonical job states', async () => {
    const queued = await createQueuedJob();
    const processing = await createQueuedJob();
    const acquired = await acquireJobForDelivery(
      processing.id,
      workerOneId,
      5_000
    );
    expect(acquired.kind).toBe('ACQUIRED');

    const counts = await getJobCounts();
    expect(counts).toMatchObject({
      [JobStatus.QUEUED]: 1,
      [JobStatus.PROCESSING]: 1,
      [JobStatus.SUCCEEDED]: 0,
    });
    expect(queued.status).toBe(JobStatus.QUEUED);
  });

  it('uses the current attempt row when recovering an expired lease', async () => {
    const created = await createQueuedJob(3);
    const firstLease = await acquireJobForDelivery(
      created.id,
      workerOneId,
      5_000
    );
    expect(firstLease.kind).toBe('ACQUIRED');
    if (firstLease.kind !== 'ACQUIRED') return;
    await startJobAttempt(created.id, workerOneId, firstLease.job.leaseId!);

    await sql`
      UPDATE jobs
      SET started_at = clock_timestamp() - interval '1 hour',
          lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${created.id}
    `;
    await sql`
      UPDATE job_attempts
      SET started_at = clock_timestamp() - interval '2 seconds'
      WHERE job_id = ${created.id} AND attempt_number = 1
    `;

    const replacement = await acquireJobForDelivery(
      created.id,
      workerTwoId,
      5_000
    );
    expect(replacement.kind).toBe('ACQUIRED');
    if (replacement.kind !== 'ACQUIRED') return;

    const [expiredAttempt] = await sql<
      Array<{ status: string; duration_ms: number }>
    >`
      SELECT status, duration_ms
      FROM job_attempts
      WHERE job_id = ${created.id} AND attempt_number = 1
    `;
    expect(expiredAttempt?.status).toBe(JobStatus.FAILED);
    expect(expiredAttempt?.duration_ms).toBeGreaterThanOrEqual(1_000);
    expect(expiredAttempt?.duration_ms).toBeLessThan(10_000);

    await startJobAttempt(created.id, workerTwoId, replacement.job.leaseId!);
    await completeJobDelivery(
      created.id,
      workerTwoId,
      replacement.job.leaseId!,
      {
        recovered: true,
      }
    );

    const events = await sql<Array<{ event_sequence: number }>>`
      SELECT event_sequence
      FROM job_events
      WHERE job_id = ${created.id}
      ORDER BY event_sequence
    `;
    expect(events.map((event) => event.event_sequence)).toEqual(
      events.map((_, index) => index + 1)
    );
  });

  it('atomically schedules an exactly-timed successor before it is claimable', async () => {
    const created = await createQueuedJob(3);
    await sql`
      UPDATE job_deliveries
      SET status = 'PUBLISHED',
          redis_message_id = '1000-0',
          published_at = clock_timestamp()
      WHERE job_id = ${created.id} AND attempt = 1
    `;
    const acquired = await acquireJobForDelivery(
      created.id,
      workerOneId,
      5_000
    );
    expect(acquired.kind).toBe('ACQUIRED');
    if (acquired.kind !== 'ACQUIRED') return;
    await startJobAttempt(created.id, workerOneId, acquired.job.leaseId!);

    const beforeFailure = Date.now();
    const outcome = await failJobDelivery(
      created.id,
      workerOneId,
      acquired.job.leaseId!,
      new Error('temporary database dependency failure'),
      { baseDelayMs: 500, maxDelayMs: 1_000 }
    );
    const afterFailure = Date.now();

    expect(outcome.terminal).toBe(false);
    if (outcome.terminal) return;
    expect(outcome.retryDelayMs).toBe(500);
    expect(outcome.successorDelivery).toMatchObject({
      jobId: created.id,
      attempt: 2,
      status: 'PENDING',
    });
    expect(outcome.job.status).toBe(JobStatus.RETRY_SCHEDULED);
    expect(outcome.job.scheduledAt.getTime()).toBe(
      outcome.successorDelivery.availableAt.getTime()
    );
    expect(outcome.job.scheduledAt.getTime()).toBeGreaterThanOrEqual(
      beforeFailure + 450
    );
    expect(outcome.job.scheduledAt.getTime()).toBeLessThanOrEqual(
      afterFailure + 550
    );

    const [persisted] = await sql<
      Array<{
        attempt_status: string;
        delivery_status: string;
        same_due_time: boolean;
        event_type: string;
      }>
    >`
      SELECT attempt.status AS attempt_status,
             successor.status AS delivery_status,
             successor.available_at = job.scheduled_at AS same_due_time,
             event.event_type
      FROM jobs AS job
      JOIN job_attempts AS attempt
        ON attempt.job_id = job.id AND attempt.attempt_number = 1
      JOIN job_deliveries AS successor
        ON successor.job_id = job.id AND successor.attempt = 2
      JOIN job_events AS event
        ON event.job_id = job.id AND event.event_sequence = job.event_sequence
      WHERE job.id = ${created.id}
    `;
    expect(persisted).toEqual({
      attempt_status: JobStatus.FAILED,
      delivery_status: 'PENDING',
      same_due_time: true,
      event_type: 'failed',
    });
    await expect(claimPendingDeliveries('dispatcher-test')).resolves.toEqual(
      []
    );

    await sql`
      UPDATE job_deliveries
      SET available_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${outcome.successorDelivery.id}
    `;
    const due = await claimPendingDeliveries('dispatcher-test');
    expect(due.map(({ id }) => id)).toEqual([outcome.successorDelivery.id]);

    await sql`
      UPDATE jobs
      SET scheduled_at = clock_timestamp() - interval '1 second'
      WHERE id = ${created.id}
    `;
    await sql`
      UPDATE job_deliveries
      SET status = 'PUBLISHED',
          published_at = clock_timestamp() - interval '1 second',
          claimed_by = NULL,
          claimed_at = NULL,
          redis_message_id = attempt::text || '-0'
      WHERE job_id = ${created.id}
    `;
    const stale = await getStaleDeliveries(0);
    expect(stale.map(({ attempt }) => attempt)).toEqual([2]);
  });

  it('dead-letters exhausted and permanent failures without a successor', async () => {
    for (const testCase of [
      { maxAttempts: 1, error: new Error('temporary') },
      {
        maxAttempts: 3,
        error: new PermanentJobError('handler is not registered'),
      },
    ]) {
      const created = await createQueuedJob(testCase.maxAttempts);
      const acquired = await acquireJobForDelivery(
        created.id,
        workerOneId,
        5_000
      );
      expect(acquired.kind).toBe('ACQUIRED');
      if (acquired.kind !== 'ACQUIRED') continue;
      await startJobAttempt(created.id, workerOneId, acquired.job.leaseId!);

      const outcome = await failJobDelivery(
        created.id,
        workerOneId,
        acquired.job.leaseId!,
        testCase.error,
        { baseDelayMs: 100, maxDelayMs: 1_000 }
      );
      expect(outcome).toMatchObject({ terminal: true });
      expect(outcome.job.status).toBe(JobStatus.DEAD_LETTERED);

      const [counts] = await sql<
        Array<{ successor_count: number; dead_letter_count: number }>
      >`
        SELECT
          count(*) FILTER (WHERE delivery.attempt > 1)::integer AS successor_count,
          (SELECT count(*)::integer FROM dead_letter_jobs WHERE original_job_id = ${created.id}) AS dead_letter_count
        FROM job_deliveries AS delivery
        WHERE delivery.job_id = ${created.id}
      `;
      expect(counts).toEqual({ successor_count: 0, dead_letter_count: 1 });
    }
  });

  it('serializes concurrent idempotent creation and detects conflicting content', async () => {
    const requestHash = 'a'.repeat(64);
    const calls = await Promise.all(
      Array.from({ length: 5 }, () =>
        createJobWithIdempotency(
          {
            userId,
            queueId,
            type: 'idempotency-contract-test',
            payload: { stable: true },
            maxAttempts: 3,
          },
          userId,
          'same-key',
          requestHash,
          60_000
        )
      )
    );

    expect(
      calls.filter(({ disposition }) => disposition === 'created')
    ).toHaveLength(1);
    expect(
      calls.filter(({ disposition }) => disposition === 'replayed')
    ).toHaveLength(4);
    expect(new Set(calls.map(({ job }) => job.id)).size).toBe(1);
    expect(new Set(calls.map(({ queueName }) => queueName))).toEqual(
      new Set(['default'])
    );

    const [counts] = await sql<
      Array<{ jobs: number; deliveries: number; keys: number }>
    >`
      SELECT
        (SELECT count(*)::integer FROM jobs) AS jobs,
        (SELECT count(*)::integer FROM job_deliveries) AS deliveries,
        (SELECT count(*)::integer FROM idempotency_keys) AS keys
    `;
    expect(counts).toEqual({ jobs: 1, deliveries: 1, keys: 1 });

    await expect(
      createJobWithIdempotency(
        {
          userId,
          queueId,
          type: 'idempotency-contract-test',
          payload: { stable: false },
          maxAttempts: 3,
        },
        userId,
        'same-key',
        'b'.repeat(64),
        60_000
      )
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('reuses an expired idempotency key and cascades key cleanup with its job', async () => {
    const first = await createJobWithIdempotency(
      { userId, queueId, type: 'first', payload: {}, maxAttempts: 1 },
      userId,
      'reusable-key',
      'c'.repeat(64),
      60_000
    );
    await sql`
      UPDATE idempotency_keys
      SET expires_at = clock_timestamp() - interval '1 second'
      WHERE user_id = ${userId} AND idempotency_key = 'reusable-key'
    `;

    const second = await createJobWithIdempotency(
      { userId, queueId, type: 'second', payload: {}, maxAttempts: 1 },
      userId,
      'reusable-key',
      'd'.repeat(64),
      60_000
    );
    expect(second.disposition).toBe('created');
    expect(second.job.id).not.toBe(first.job.id);

    await sql`DELETE FROM jobs WHERE id = ${second.job.id}`;
    const [remaining] = await sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM idempotency_keys
      WHERE user_id = ${userId} AND idempotency_key = 'reusable-key'
    `;
    expect(remaining?.count).toBe(0);
  });

  it('claims the highest priority first, then oldest, and can scope a claim to one queue', async () => {
    const otherQueueId = '20000000-0000-4000-8000-000000000002';
    await sql`
      INSERT INTO queues (id, name, display_name)
      VALUES (${otherQueueId}, 'other', 'Other')
    `;
    const create = (
      priority: string,
      targetQueue = queueId
    ): ReturnType<typeof createJob> =>
      createJob({
        userId,
        queueId: targetQueue,
        type: `priority-${priority}`,
        payload: {},
        maxAttempts: 1,
        priority: priority as 'LOW',
      });

    // Created oldest-first; priority must win over age.
    const low1 = await create('LOW');
    const low2 = await create('LOW');
    const normal = await create('NORMAL');
    const critical = await create('CRITICAL');
    const high = await create('HIGH');
    const otherCritical = await create('CRITICAL', otherQueueId);

    const ranks = await sql<Array<{ job_id: string; priority_rank: number }>>`
      SELECT job_id, priority_rank FROM job_deliveries
    `;
    const rankOf = (jobId: string): number | undefined =>
      ranks.find((row) => row.job_id === jobId)?.priority_rank;
    expect([
      rankOf(critical.id),
      rankOf(high.id),
      rankOf(normal.id),
      rankOf(low1.id),
    ]).toEqual([4, 3, 2, 1]);

    const scoped = await claimPendingDeliveries(
      'dispatcher-scoped',
      10,
      30_000,
      'default'
    );
    expect(scoped.map(({ jobId }) => jobId)).toEqual([
      critical.id,
      high.id,
      normal.id,
      low1.id,
      low2.id,
    ]);
    expect(scoped.map(({ jobId }) => jobId)).not.toContain(otherCritical.id);

    // The other queue's row was untouched by the scoped claim.
    const rest = await claimPendingDeliveries('dispatcher-rest', 10, 30_000);
    expect(rest.map(({ jobId }) => jobId)).toEqual([otherCritical.id]);
  });

  it('gives a retry successor the same priority as its job', async () => {
    const created = await createJob({
      userId,
      queueId,
      type: 'priority-retry',
      payload: {},
      maxAttempts: 3,
      priority: 'HIGH',
    });
    const acquired = await acquireJobForDelivery(
      created.id,
      workerOneId,
      5_000
    );
    if (acquired.kind !== 'ACQUIRED') throw new Error('expected lease');
    await startJobAttempt(created.id, workerOneId, acquired.job.leaseId!);

    const outcome = await failJobDelivery(
      created.id,
      workerOneId,
      acquired.job.leaseId!,
      new Error('transient'),
      { baseDelayMs: 100, maxDelayMs: 1_000 }
    );

    expect(outcome.terminal).toBe(false);
    const [successor] = await sql<Array<{ priority_rank: number }>>`
      SELECT priority_rank FROM job_deliveries
      WHERE job_id = ${created.id} AND attempt = 2
    `;
    expect(successor?.priority_rank).toBe(3);
  });

  it('releases an owned lease on shutdown without consuming the attempt budget', async () => {
    const created = await createQueuedJob(1);
    await sql`
      UPDATE job_deliveries
      SET status = 'PUBLISHED', redis_message_id = '1-0',
          published_at = clock_timestamp()
      WHERE job_id = ${created.id}
    `;
    const acquired = await acquireJobForDelivery(
      created.id,
      workerOneId,
      5_000
    );
    expect(acquired.kind).toBe('ACQUIRED');
    if (acquired.kind !== 'ACQUIRED') return;
    await startJobAttempt(created.id, workerOneId, acquired.job.leaseId!);

    // A stale lease ID cannot release someone else's ownership.
    await expect(
      releaseJobDelivery(created.id, workerOneId, crypto.randomUUID())
    ).resolves.toBeNull();

    const released = await releaseJobDelivery(
      created.id,
      workerOneId,
      acquired.job.leaseId!
    );
    expect(released).toMatchObject({
      status: JobStatus.QUEUED,
      attempts: 0,
      leaseId: null,
      workerId: null,
      startedAt: null,
    });

    const [state] = await sql<
      Array<{ attempt_rows: number; delivery_status: string; event: string }>
    >`
      SELECT
        (SELECT count(*)::integer FROM job_attempts WHERE job_id = ${created.id}) AS attempt_rows,
        (SELECT status FROM job_deliveries WHERE job_id = ${created.id} AND attempt = 1) AS delivery_status,
        (SELECT event_type FROM job_events WHERE job_id = ${created.id}
          ORDER BY event_sequence DESC LIMIT 1) AS event
    `;
    expect(state).toEqual({
      attempt_rows: 0,
      delivery_status: 'PENDING',
      event: 'lease_released',
    });

    // maxAttempts=1: the refunded job is still executable, not stranded.
    const again = await acquireJobForDelivery(created.id, workerTwoId, 5_000);
    expect(again.kind).toBe('ACQUIRED');
  });

  it('lets a result win over an unobserved cancel request, and cancels instead of retrying a failure', async () => {
    const completing = await createQueuedJob(3);
    const failing = await createQueuedJob(3);
    const leases: Record<string, string> = {};
    for (const job of [completing, failing]) {
      const acquired = await acquireJobForDelivery(job.id, workerOneId, 5_000);
      if (acquired.kind !== 'ACQUIRED') throw new Error('expected lease');
      leases[job.id] = acquired.job.leaseId!;
      await startJobAttempt(job.id, workerOneId, leases[job.id]!);
      await sql`UPDATE jobs SET status = 'CANCEL_REQUESTED' WHERE id = ${job.id}`;
    }

    const completed = await completeJobDelivery(
      completing.id,
      workerOneId,
      leases[completing.id]!,
      { done: true }
    );
    expect(completed.status).toBe(JobStatus.SUCCEEDED);

    await expect(
      failJobDelivery(
        failing.id,
        workerOneId,
        leases[failing.id]!,
        new Error('transient'),
        { baseDelayMs: 100, maxDelayMs: 1_000 }
      )
    ).rejects.toBeInstanceOf(JobCancellationRequestedError);
    const [unchanged] = await sql<
      Array<{ status: string; successors: number }>
    >`
      SELECT status,
        (SELECT count(*)::integer FROM job_deliveries
          WHERE job_id = ${failing.id} AND attempt > 1) AS successors
      FROM jobs WHERE id = ${failing.id}
    `;
    expect(unchanged).toEqual({ status: 'CANCEL_REQUESTED', successors: 0 });
  });

  it('gives concurrent schedulers disjoint due jobs, oldest first, on the database clock', async () => {
    const due = [];
    for (let i = 0; i < 20; i += 1) {
      due.push(
        await createJob({
          userId,
          queueId,
          type: 'scheduled-contract-test',
          payload: { i },
          maxAttempts: 1,
          scheduledAt: new Date(Date.now() + 60_000),
        })
      );
    }
    await sql`
      UPDATE jobs
      SET scheduled_at = clock_timestamp() - (interval '1 second' * (100 - (payload->>'i')::int))
      WHERE type = 'scheduled-contract-test'
    `;
    // One job stays in the future and must not be promoted.
    const future = await createJob({
      userId,
      queueId,
      type: 'future-contract-test',
      payload: {},
      maxAttempts: 1,
      scheduledAt: new Date(Date.now() + 3_600_000),
    });

    const batches = await Promise.all(
      Array.from({ length: 4 }, () => promoteDueScheduledJobs(10))
    );
    const promotedIds = batches.flatMap((b) => b.promoted.map(({ id }) => id));
    expect(batches.flatMap((b) => b.failed)).toEqual([]);
    expect(promotedIds).toHaveLength(20);
    expect(new Set(promotedIds).size).toBe(20);
    expect(promotedIds).not.toContain(future.id);

    const [counts] = await sql<Array<{ queued: number; deliveries: number }>>`
      SELECT
        count(*) FILTER (WHERE status = 'QUEUED')::integer AS queued,
        (SELECT count(*)::integer FROM job_deliveries
          WHERE job_id IN (SELECT id FROM jobs WHERE type = 'scheduled-contract-test')) AS deliveries
      FROM jobs WHERE type = 'scheduled-contract-test'
    `;
    expect(counts).toEqual({ queued: 20, deliveries: 20 });
    expect(due).toHaveLength(20);
  });

  it('reports per-queue job counts, a priority backlog with its age, and only live workers', async () => {
    const otherQueueId = '20000000-0000-4000-8000-000000000003';
    await sql`
      INSERT INTO queues (id, name, display_name)
      VALUES (${otherQueueId}, 'other', 'Other')
    `;
    const make = (
      priority: string,
      targetQueue = queueId
    ): ReturnType<typeof createJob> =>
      createJob({
        userId,
        queueId: targetQueue,
        type: 'snapshot',
        payload: {},
        maxAttempts: 1,
        priority: priority as 'LOW',
      });
    await make('HIGH');
    await make('HIGH');
    await make('LOW');
    await make('NORMAL', otherQueueId);
    // Age the HIGH backlog so the oldest-age figure is checkable.
    await sql`
      UPDATE jobs SET scheduled_at = clock_timestamp() - interval '90 seconds'
      WHERE priority = 'HIGH'
    `;

    // workerOne: heartbeating. workerTwo: ACTIVE but silent for 10 minutes
    // (a crashed process). A third worker has stopped.
    // workerOne serves two queues; it must still be counted once in the total.
    await sql`
      UPDATE workers
      SET last_heartbeat_at = clock_timestamp(), queues = ARRAY['default', 'other']
      WHERE id = ${workerOneId}
    `;
    await sql`UPDATE workers SET last_heartbeat_at = clock_timestamp() - interval '10 minutes' WHERE id = ${workerTwoId}`;
    await sql`
      INSERT INTO workers (worker_name, hostname, process_id, queues, status, last_heartbeat_at)
      VALUES ('stopped-worker', 'localhost', 3, ARRAY['default'], 'STOPPED', clock_timestamp())
    `;

    const snapshot = await getMetricsSnapshot();

    expect(snapshot.jobs).toEqual(
      expect.arrayContaining([
        { queue: 'default', status: 'QUEUED', count: 3 },
        { queue: 'other', status: 'QUEUED', count: 1 },
      ])
    );

    const high = snapshot.backlog.find(
      (row) => row.queue === 'default' && row.priority === 'HIGH'
    );
    expect(high?.depth).toBe(2);
    expect(high?.oldestAgeSeconds).toBeGreaterThanOrEqual(89);
    expect(high?.oldestAgeSeconds).toBeLessThan(120);
    expect(
      snapshot.backlog.find(
        (row) => row.queue === 'default' && row.priority === 'LOW'
      )?.depth
    ).toBe(1);

    // Only the heartbeating worker counts: not the silent one, not the stopped one.
    expect(snapshot.liveWorkers).toHaveLength(2);
    expect(snapshot.liveWorkers).toEqual(
      expect.arrayContaining([
        { queue: 'default', workers: 1 },
        { queue: 'other', workers: 1 },
      ])
    );
    // One worker serving two queues is still one worker.
    expect(snapshot.liveWorkerTotal).toBe(1);

    await expect(getMetricsSnapshot({ workerStaleAfterMs: 0 })).rejects.toThrow(
      RangeError
    );
  });

  it('authenticates only a live hashed key owned by an active user', async () => {
    const plaintext = 'database-backed-test-key';
    const keyHash = hashApiKey(plaintext, 'integration-test-salt');
    await sql`
      INSERT INTO api_keys (user_id, name, key_hash, expires_at)
      VALUES (${userId}, 'integration', ${keyHash}, clock_timestamp() + interval '1 hour')
    `;

    await expect(findActiveUserByApiKey(plaintext)).resolves.toEqual({
      id: userId,
      email: 'persistence-contract@example.test',
      role: 'user',
    });

    await sql`
      UPDATE api_keys SET revoked_at = clock_timestamp()
      WHERE key_hash = ${keyHash}
    `;
    await expect(findActiveUserByApiKey(plaintext)).resolves.toBeUndefined();

    await sql`
      UPDATE api_keys SET revoked_at = NULL, expires_at = NULL
      WHERE key_hash = ${keyHash}
    `;
    await sql`UPDATE users SET is_active = false WHERE id = ${userId}`;
    await expect(findActiveUserByApiKey(plaintext)).resolves.toBeUndefined();
  });
});
