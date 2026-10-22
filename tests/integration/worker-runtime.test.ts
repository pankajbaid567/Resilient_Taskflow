import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import Redis from 'ioredis';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  cleanupBoundedDeadLetters,
  cleanupBoundedJobAttempts,
  cleanupBoundedJobDeliveries,
  cleanupBoundedJobEvents,
  cleanupBoundedJobs,
  cleanupBoundedWorkers,
  closeConnection,
  hashApiKey,
  runDatabaseRetention,
} from '@taskflow/database';
import {
  executeFullRetention,
  RETENTION_LOCK_KEY,
  RetentionScheduler,
} from '@taskflow/worker';
import {
  closeRedisConnection,
  getStreamKey,
  WORKER_CONSUMER_GROUP,
} from '@taskflow/queue';
import {
  JobStatus,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';

const root = path.resolve(__dirname, '../..');
const composeFile = path.join(__dirname, 'worker-runtime.compose.yml');
const composeArgs = ['compose', '-p', 'taskflow-worker-it', '-f', composeFile];
const databaseUrl =
  'postgresql://taskflow_test:taskflow_test@127.0.0.1:55439/taskflow_test';
const redisUrl = 'redis://127.0.0.1:56389';
const jwtSecret = 'taskflow-integration-secret-at-least-32-characters';
const apiKey = 'worker-runtime-api-key';
const userId = '00000000-0000-4000-8000-000000000001';
const queueId = '20000000-0000-4000-8000-000000000001';
const stream = getStreamKey('default');

interface RuntimeProcess {
  child: ChildProcess;
  output: string;
  closed: Promise<{
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }>;
}

interface ApiTestApp {
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload: Record<string, unknown>;
  }): Promise<{
    statusCode: number;
    body: string;
    json<T>(): T;
  }>;
  close(): Promise<void>;
}

interface JobRow {
  status: JobStatus;
  attempts: number;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

let pool: Pool;
let redis: Redis;
let app: ApiTestApp;
const workerProcesses = new Set<RuntimeProcess>();

function docker(...args: string[]): string {
  const result = spawnSync('docker', [...composeArgs, ...args], {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`
    );
  }

  return result.stdout;
}

function migrateDatabase(): void {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@taskflow/database', 'db:migrate'],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        JWT_SECRET: jwtSecret,
        API_KEY_HASH_SALT: 'integration-test-salt',
        LOG_LEVEL: 'error',
      },
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `database migration runner failed:\n${result.stdout}\n${result.stderr}`
    );
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label: string }
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      lastValue = await read();
      if (predicate(lastValue)) return lastValue;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `${options.label} not met within ${timeoutMs}ms; last=${JSON.stringify(
      lastValue
    )}; error=${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function startWorker(overrides: Record<string, string> = {}): RuntimeProcess {
  const workerEntryPoint = path.join(root, 'apps/worker/dist/index.js');
  const child = spawn(process.execPath, [workerEntryPoint], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MIN: '0',
      DATABASE_POOL_MAX: '4',
      REDIS_URL: redisUrl,
      JWT_SECRET: jwtSecret,
      API_KEY_HASH_SALT: 'integration-test-salt',
      WORKER_QUEUES: 'default',
      // Several workers run at once in these tests and a dev worker may be
      // running on this machine; none of them need the metrics port.
      WORKER_METRICS_PORT: '0',
      WORKER_CONCURRENCY: '1',
      WORKER_HEARTBEAT_INTERVAL_MS: '100',
      WORKER_LEASE_DURATION_MS: '600',
      JOB_RETRY_BASE_DELAY_MS: '300',
      JOB_RETRY_MAX_DELAY_MS: '600',
      TASKFLOW_TEST_STALE_THRESHOLD_MS: '50',
      TASKFLOW_TEST_POLL_INTERVAL_MS: '20',
      TASKFLOW_TEST_DATABASE_CONNECT_TIMEOUT_SECONDS: '1',
      LOG_LEVEL: 'info',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const closed = new Promise<{
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (exitCode, signalCode) => {
      resolve({ exitCode, signalCode });
    });
  });
  const runtime: RuntimeProcess = { child, output: '', closed };
  const collect = (chunk: Buffer | string) => {
    runtime.output += chunk.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  workerProcesses.add(runtime);
  return runtime;
}

async function waitForWorkerReady(runtime: RuntimeProcess): Promise<void> {
  await waitFor(
    async () => {
      if (
        runtime.child.exitCode !== null ||
        runtime.child.signalCode !== null
      ) {
        throw new Error(`worker exited before ready:\n${runtime.output}`);
      }
      return runtime.output;
    },
    (output) => output.includes('WORKER_READY'),
    { timeoutMs: 10_000, label: 'worker readiness' }
  );
}

async function waitForWorkerExit(
  runtime: RuntimeProcess
): Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }> {
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    runtime.closed,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`worker did not close; output=${runtime.output}`));
      }, 10_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  workerProcesses.delete(runtime);
  return outcome;
}

async function killWorker(runtime: RuntimeProcess): Promise<void> {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    const pid = runtime.child.pid;
    if (pid !== undefined) {
      try {
        if (process.platform === 'win32') runtime.child.kill('SIGKILL');
        else process.kill(-pid, 'SIGKILL');
      } catch {
        runtime.child.kill('SIGKILL');
      }
    }
  }

  await waitForWorkerExit(runtime);
}

async function stopWorker(runtime: RuntimeProcess): Promise<void> {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    if (!runtime.child.kill('SIGTERM')) {
      throw new Error('Failed to send SIGTERM to worker process');
    }
  }

  await expect(waitForWorkerExit(runtime)).resolves.toEqual({
    exitCode: 0,
    signalCode: null,
  });
}

async function killAllWorkers(): Promise<void> {
  await Promise.all([...workerProcesses].map(killWorker));
}

async function submitJob(
  options: {
    type?: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    timeoutMs?: number;
    scheduledAt?: string;
    priority?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
    expectedStatus?: JobStatus;
  } = {}
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { 'x-api-key': apiKey },
    payload: {
      type: options.type ?? 'test-idempotent',
      queue: 'default',
      payload: options.payload ?? {},
      ...(options.maxAttempts === undefined
        ? {}
        : { maxAttempts: options.maxAttempts }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.scheduledAt === undefined
        ? {}
        : { scheduledAt: options.scheduledAt }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    },
  });

  expect(response.statusCode, response.body).toBe(201);
  const submitted = response.json<{ id: string; status: JobStatus }>();
  expect(submitted.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(submitted.status).toBe(options.expectedStatus ?? JobStatus.QUEUED);
  return submitted.id;
}

async function cancelJobThroughApi(jobId: string): Promise<JobStatus> {
  const response = await app.inject({
    method: 'DELETE',
    url: `/api/v1/jobs/${jobId}`,
    headers: { 'x-api-key': apiKey },
    payload: {},
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ status: JobStatus }>().status;
}

async function readJob(jobId: string): Promise<JobRow | undefined> {
  const result = await pool.query<JobRow>(
    `SELECT status, attempts, result, error
       FROM jobs
      WHERE id = $1`,
    [jobId]
  );
  return result.rows[0];
}

async function waitForJobStatus(
  jobId: string,
  status: JobStatus,
  timeoutMs = 15_000
): Promise<JobRow> {
  const job = await waitFor(
    () => readJob(jobId),
    (job): job is JobRow => job?.status === status,
    { timeoutMs, label: `job ${jobId} status ${status}` }
  );
  if (!job) throw new Error(`Job ${jobId} disappeared while waiting`);
  return job;
}

type PendingEntry = [
  messageId: string,
  consumer: string,
  idleMs: number,
  deliveries: number,
];

async function pendingEntries(): Promise<PendingEntry[]> {
  return (await redis.xpending(
    stream,
    WORKER_CONSUMER_GROUP,
    '-',
    '+',
    100
  )) as PendingEntry[];
}

async function waitForPendingCount(
  count: number,
  timeoutMs = 10_000
): Promise<PendingEntry[]> {
  return waitFor(pendingEntries, (entries) => entries.length === count, {
    timeoutMs,
    label: `Redis pending count ${count}`,
  });
}

async function counts(jobId: string): Promise<{
  executions: number;
  effectAttempts: number;
  effects: number;
  attempts: number;
  deadLetters: number;
}> {
  const result = await pool.query<{
    executions: string;
    effect_attempts: string;
    effects: string;
    attempts: string;
    dead_letters: string;
  }>(
    `SELECT
       (SELECT count(*) FROM test_handler_executions WHERE job_id = $1) AS executions,
       (SELECT count(*) FROM test_effect_attempts WHERE job_id = $1) AS effect_attempts,
       (SELECT count(*) FROM test_effects WHERE job_id = $1) AS effects,
       (SELECT count(*) FROM job_attempts WHERE job_id = $1) AS attempts,
       (SELECT count(*) FROM dead_letter_jobs WHERE original_job_id = $1) AS dead_letters`,
    [jobId]
  );
  const row = result.rows[0]!;
  return {
    executions: Number(row.executions),
    effectAttempts: Number(row.effect_attempts),
    effects: Number(row.effects),
    attempts: Number(row.attempts),
    deadLetters: Number(row.dead_letters),
  };
}

async function deliveryStatus(
  jobId: string
): Promise<{ status: string; redis_message_id: string | null } | undefined> {
  const result = await pool.query<{
    status: string;
    redis_message_id: string | null;
  }>(
    `SELECT status, redis_message_id
       FROM job_deliveries
      WHERE job_id = $1
      ORDER BY attempt DESC
      LIMIT 1`,
    [jobId]
  );
  return result.rows[0];
}

async function messageEnvelope(
  jobId: string
): Promise<Record<string, unknown>> {
  const entries = (await redis.xrange(stream, '-', '+')) as Array<
    [string, string[]]
  >;

  for (const [, fields] of entries) {
    const dataIndex = fields.indexOf(REDIS_JOB_MESSAGE_FIELD);
    if (dataIndex === -1) continue;
    const envelope = JSON.parse(fields[dataIndex + 1]!) as Record<
      string,
      unknown
    >;
    if (envelope.jobId === jobId) return envelope;
  }

  throw new Error(`No Redis envelope found for job ${jobId}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  docker('down', '--volumes', '--remove-orphans');
  docker('up', '-d', '--wait');
  migrateDatabase();

  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  // PostgreSQL is intentionally stopped in one test. Idle pooled clients emit
  // this event independently of the lease-acquisition promise under test.
  pool.on('error', () => undefined);
  redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  await pool.query(
    `CREATE TABLE test_handler_executions (
       id bigserial PRIMARY KEY,
       job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       executed_at timestamptz NOT NULL DEFAULT now()
     );
     CREATE TABLE test_effects (
       job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       effect_key text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (job_id, effect_key)
     );
     CREATE TABLE test_effect_attempts (
       id bigserial PRIMARY KEY,
       job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       effect_key text NOT NULL,
       attempted_at timestamptz NOT NULL DEFAULT now()
     );`
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'worker-it@example.test', 'unused', 'admin')`,
    [userId]
  );
  await pool.query(
    `INSERT INTO api_keys (user_id, name, key_hash)
     VALUES ($1, 'worker-runtime', $2)`,
    [userId, hashApiKey(apiKey)]
  );
  await pool.query(
    `INSERT INTO queues (id, name, display_name)
     VALUES ($1, 'default', 'Default')`,
    [queueId]
  );
  const apiAppPath = path.join(root, 'apps/api/src/app.ts');
  const apiModule = (await import(apiAppPath)) as {
    createApp(): Promise<ApiTestApp>;
  };
  app = await apiModule.createApp();
}, 60_000);

beforeEach(async () => {
  await killAllWorkers();
  docker('up', '-d', '--wait');
  await redis.flushall();
  await pool.query(
    `TRUNCATE TABLE
       operational_audit_logs,
       job_deliveries,
       idempotency_keys,
       dead_letter_jobs,
       job_events,
       job_attempts,
       test_handler_executions,
       test_effect_attempts,
       test_effects,
       jobs,
       workers
     RESTART IDENTITY CASCADE`
  );
  await pool.query(`UPDATE queues SET is_active = true`);
});

afterEach(async () => {
  await killAllWorkers();
});

afterAll(async () => {
  await killAllWorkers();
  await app?.close();
  await redis?.quit();
  await pool?.end();
  await Promise.allSettled([closeRedisConnection(), closeConnection()]);
  docker('down', '--volumes', '--remove-orphans');
}, 30_000);

describe.sequential('authoritative worker delivery', () => {
  describe('operational controls', () => {
    it('holds durable delivery while a queue is paused and resumes processing', async () => {
      const jobId = await submitJob({
        payload: { effectKey: 'pause-resume' },
      });
      const paused = await app.inject({
        method: 'POST',
        url: '/api/v1/queues/default/pause',
        headers: { 'x-api-key': apiKey },
        payload: {},
      });
      expect(paused.statusCode, paused.body).toBe(200);
      expect(paused.json<{ isActive: boolean }>().isActive).toBe(false);

      const worker = startWorker();
      await waitForWorkerReady(worker);
      await sleep(500);
      expect(await readJob(jobId)).toMatchObject({
        status: JobStatus.QUEUED,
        attempts: 0,
      });
      // Worker startup creates the consumer-group stream, but a paused queue
      // must not publish the durable outbox row into it.
      expect(await redis.xlen(stream)).toBe(0);

      const resumed = await app.inject({
        method: 'POST',
        url: '/api/v1/queues/default/resume',
        headers: { 'x-api-key': apiKey },
        payload: {},
      });
      expect(resumed.statusCode, resumed.body).toBe(200);
      expect(resumed.json<{ isActive: boolean }>().isActive).toBe(true);
      await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
      await waitForPendingCount(0);

      const audit = await pool.query<{
        action: string;
        outcome: string;
        status_code: number;
        metadata: Record<string, unknown>;
      }>(
        `SELECT action, outcome, status_code, metadata
           FROM operational_audit_logs
          WHERE target_type = 'queue' AND target_id = 'default'
          ORDER BY created_at`
      );
      expect(audit.rows).toEqual([
        {
          action: 'queue.pause',
          outcome: 'SUCCEEDED',
          status_code: 200,
          metadata: { isActive: false },
        },
        {
          action: 'queue.resume',
          outcome: 'SUCCEEDED',
          status_code: 200,
          metadata: { isActive: true },
        },
      ]);
    }, 20_000);

    it('turns an API stop request into a clean worker-process shutdown', async () => {
      const worker = startWorker();
      await waitForWorkerReady(worker);
      const active = await pool.query<{ id: string }>(
        `SELECT id FROM workers WHERE status = 'ACTIVE' LIMIT 1`
      );
      const workerId = active.rows[0]?.id;
      expect(workerId).toMatch(/^[0-9a-f-]{36}$/);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/workers/${workerId}/stop`,
        headers: { 'x-api-key': apiKey },
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(202);
      await expect(waitForWorkerExit(worker)).resolves.toEqual({
        exitCode: 0,
        signalCode: null,
      });
      const stopped = await pool.query<{ status: string }>(
        `SELECT status FROM workers WHERE id = $1`,
        [workerId]
      );
      expect(stopped.rows[0]?.status).toBe('STOPPED');
      const audit = await pool.query<{
        actor_user_id: string;
        action: string;
        outcome: string;
        status_code: number;
      }>(
        `SELECT actor_user_id, action, outcome, status_code
           FROM operational_audit_logs
          WHERE target_type = 'worker' AND target_id = $1`,
        [workerId]
      );
      expect(audit.rows).toEqual([
        {
          actor_user_id: userId,
          action: 'worker.stop',
          outcome: 'SUCCEEDED',
          status_code: 202,
        },
      ]);
    }, 20_000);

    it('creates one owned replacement for a dead-lettered job and executes it', async () => {
      const worker = startWorker();
      await waitForWorkerReady(worker);
      const originalJobId = await submitJob({
        payload: {
          effectKey: 'manual-retry',
          failUntilManualRetry: true,
        },
        maxAttempts: 1,
      });
      await waitForJobStatus(originalJobId, JobStatus.DEAD_LETTERED);

      const retry = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${originalJobId}/retry`,
        headers: { 'x-api-key': apiKey },
        payload: {},
      });
      expect(retry.statusCode, retry.body).toBe(201);
      const replacementId = retry.json<{ id: string }>().id;
      expect(replacementId).not.toBe(originalJobId);

      const repeated = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${originalJobId}/retry`,
        headers: { 'x-api-key': apiKey },
        payload: {},
      });
      expect(repeated.statusCode, repeated.body).toBe(409);
      await waitForJobStatus(replacementId, JobStatus.SUCCEEDED);
      await waitForPendingCount(0);

      const deadLetter = await pool.query<{
        requeued: boolean;
        requeued_job_id: string;
      }>(
        `SELECT requeued, requeued_job_id
           FROM dead_letter_jobs
          WHERE original_job_id = $1`,
        [originalJobId]
      );
      expect(deadLetter.rows[0]).toEqual({
        requeued: true,
        requeued_job_id: replacementId,
      });
      const audit = await pool.query<{
        action: string;
        outcome: string;
        status_code: number;
        metadata: Record<string, unknown>;
      }>(
        `SELECT action, outcome, status_code, metadata
           FROM operational_audit_logs
          WHERE target_type = 'job' AND target_id = $1
          ORDER BY created_at`,
        [originalJobId]
      );
      expect(audit.rows).toEqual([
        {
          action: 'job.manual_retry',
          outcome: 'SUCCEEDED',
          status_code: 201,
          metadata: { replacementJobId: replacementId },
        },
        {
          action: 'job.manual_retry',
          outcome: 'REJECTED',
          status_code: 409,
          metadata: { reason: 'already_retried' },
        },
      ]);
    }, 25_000);
  });

  describe('durable lifecycle', () => {
    it('retains an API-created job in the database outbox until a worker starts', async () => {
      const jobId = await submitJob({
        payload: { effectKey: 'worker-starts-later' },
      });

      expect(await readJob(jobId)).toMatchObject({
        status: JobStatus.QUEUED,
        attempts: 0,
      });
      expect(await deliveryStatus(jobId)).toEqual({
        status: 'PENDING',
        redis_message_id: null,
      });
      expect(await redis.exists(stream)).toBe(0);

      const worker = startWorker();
      await waitForWorkerReady(worker);
      await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
      await waitForPendingCount(0);

      expect(await deliveryStatus(jobId)).toMatchObject({
        status: 'PUBLISHED',
      });
      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 1,
        effects: 1,
        attempts: 1,
        deadLetters: 0,
      });
    }, 30_000);

    it('promotes a future API-created job through the canonical scheduler and outbox', async () => {
      const worker = startWorker({
        TASKFLOW_TEST_SCHEDULER_INTERVAL_MS: '20',
      });
      await waitForWorkerReady(worker);

      const scheduledAt = new Date(Date.now() + 2_000).toISOString();
      const jobId = await submitJob({
        payload: { effectKey: 'scheduled-delivery' },
        scheduledAt,
        expectedStatus: JobStatus.CREATED,
      });

      expect(await deliveryStatus(jobId)).toBeUndefined();
      const completed = await waitForJobStatus(
        jobId,
        JobStatus.SUCCEEDED,
        15_000
      );
      expect(completed.attempts).toBe(1);
      await waitForPendingCount(0);
      expect(await deliveryStatus(jobId)).toMatchObject({
        status: 'PUBLISHED',
      });

      const transitions = await pool.query<{
        from_status: JobStatus | null;
        to_status: JobStatus;
      }>(
        `SELECT from_status, to_status
           FROM job_events
          WHERE job_id = $1
            AND from_status IS DISTINCT FROM to_status
          ORDER BY event_sequence`,
        [jobId]
      );
      expect(
        transitions.rows.map(({ from_status, to_status }) => [
          from_status,
          to_status,
        ])
      ).toEqual([
        [null, JobStatus.CREATED],
        [JobStatus.CREATED, JobStatus.QUEUED],
        [JobStatus.QUEUED, JobStatus.PROCESSING],
        [JobStatus.PROCESSING, JobStatus.SUCCEEDED],
      ]);
    }, 30_000);

    it('takes an API-created job through the shared envelope to durable SUCCEEDED before XACK', async () => {
      const barrierKey = 'taskflow:test:terminal-commit';
      const worker = startWorker({
        TASKFLOW_TEST_AFTER_COMMIT_BARRIER_KEY: barrierKey,
      });
      await waitForWorkerReady(worker);

      const jobId = await submitJob({
        type: 'process-data',
        payload: {
          operation: 'transform',
          data: [{ id: 'one', value: 1 }],
        },
      });

      const envelope = await waitFor(
        () => messageEnvelope(jobId),
        () => true,
        { timeoutMs: 10_000, label: 'canonical Redis message envelope' }
      );
      expect(envelope).toMatchObject({
        schemaVersion: REDIS_JOB_MESSAGE_VERSION,
        jobId,
        queue: 'default',
        attempt: 1,
      });

      await waitFor(
        () => redis.get(`${barrierKey}:reached`),
        (reachedJobId) => reachedJobId === jobId,
        { timeoutMs: 10_000, label: 'post-commit/pre-ack barrier' }
      );
      const job = await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
      expect(job.result).toMatchObject({
        operation: 'transform',
        recordsProcessed: 1,
      });

      // The worker is held after the terminal transaction resolves and before
      // XACK, making the ordering assertion deterministic under a slow runner.
      expect((await waitForPendingCount(1))[0]?.[3]).toBeGreaterThanOrEqual(1);

      const eventRows = await pool.query<{ to_status: JobStatus }>(
        `SELECT to_status
         FROM job_events
        WHERE job_id = $1
          AND from_status IS DISTINCT FROM to_status
        ORDER BY event_sequence`,
        [jobId]
      );
      expect(eventRows.rows.map((row) => row.to_status)).toEqual([
        JobStatus.CREATED,
        JobStatus.QUEUED,
        JobStatus.PROCESSING,
        JobStatus.SUCCEEDED,
      ]);

      const enumRows = await pool.query<{ enumlabel: string }>(
        `SELECT enumlabel
         FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname = 'job_status'
        ORDER BY enumsortorder`
      );
      expect(enumRows.rows.map((row) => row.enumlabel)).toEqual(
        Object.values(JobStatus)
      );

      await redis.set(`${barrierKey}:release`, jobId);
      await waitForPendingCount(0);
    }, 30_000);
  });

  describe('failure injection', () => {
    it('redispatches a published nonterminal job after its Redis entry is lost', async () => {
      const dispatcherOnly = startWorker({
        WORKER_QUEUES: 'other',
        TASKFLOW_TEST_DISPATCH_STALE_THRESHOLD_MS: '100',
      });
      await waitForWorkerReady(dispatcherOnly);
      const jobId = await submitJob({
        payload: { effectKey: 'redis-entry-recovered' },
      });

      const firstDelivery = await waitFor(
        () => deliveryStatus(jobId),
        (delivery) =>
          delivery?.status === 'PUBLISHED' &&
          delivery.redis_message_id !== null,
        { timeoutMs: 10_000, label: 'initial outbox publication' }
      );
      expect(firstDelivery?.redis_message_id).toBeTruthy();
      expect(await redis.del(stream)).toBe(1);

      const republished = await waitFor(
        () => deliveryStatus(jobId),
        (delivery) =>
          delivery?.status === 'PUBLISHED' &&
          delivery.redis_message_id !== null &&
          delivery.redis_message_id !== firstDelivery?.redis_message_id,
        { timeoutMs: 10_000, label: 'database-driven Redis republication' }
      );
      expect(republished?.redis_message_id).not.toBe(
        firstDelivery?.redis_message_id
      );
      expect((await readJob(jobId))?.status).toBe(JobStatus.QUEUED);

      const replacement = startWorker({ WORKER_LEASE_DURATION_MS: '1000' });
      await waitForWorkerReady(replacement);
      await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
      await waitForPendingCount(0);
      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 1,
        effects: 1,
        attempts: 1,
        deadLetters: 0,
      });
    }, 30_000);

    it('persists cooperative cancellation before acknowledging the Redis entry', async () => {
      const worker = startWorker({ WORKER_LEASE_DURATION_MS: '2000' });
      await waitForWorkerReady(worker);
      const jobId = await submitJob({
        payload: {
          effectKey: 'cancelled-before-effect',
          delayMs: 10_000,
        },
      });

      await waitForJobStatus(jobId, JobStatus.PROCESSING);
      await waitFor(
        () => counts(jobId),
        ({ executions }) => executions === 1,
        { label: 'cancellable handler execution' }
      );
      expect(await waitForPendingCount(1)).toHaveLength(1);

      expect(await cancelJobThroughApi(jobId)).toBe(JobStatus.CANCEL_REQUESTED);
      await waitForJobStatus(jobId, JobStatus.CANCELLED, 10_000);
      await waitForPendingCount(0);

      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 0,
        effects: 0,
        attempts: 1,
        deadLetters: 0,
      });
      const attempt = await pool.query<{ status: JobStatus }>(
        `SELECT status FROM job_attempts WHERE job_id = $1`,
        [jobId]
      );
      expect(attempt.rows.map(({ status }) => status)).toEqual([
        JobStatus.CANCELLED,
      ]);
    }, 30_000);

    it('lets a replacement terminalize a cancellation request after the owner is killed', async () => {
      const firstWorker = startWorker({ WORKER_LEASE_DURATION_MS: '1000' });
      await waitForWorkerReady(firstWorker);
      const jobId = await submitJob({
        payload: {
          effectKey: 'cancelled-by-replacement',
          delayMs: 10_000,
          ignoreCancellation: true,
        },
      });

      await waitForJobStatus(jobId, JobStatus.PROCESSING);
      await waitFor(
        () => counts(jobId),
        ({ executions }) => executions === 1,
        { label: 'noncooperative handler execution before cancellation' }
      );
      expect(await waitForPendingCount(1)).toHaveLength(1);
      expect(await cancelJobThroughApi(jobId)).toBe(JobStatus.CANCEL_REQUESTED);

      await killWorker(firstWorker);
      expect((await readJob(jobId))?.status).toBe(JobStatus.CANCEL_REQUESTED);
      expect(await pendingEntries()).toHaveLength(1);

      const replacement = startWorker({ WORKER_LEASE_DURATION_MS: '1000' });
      await waitForWorkerReady(replacement);
      await waitForJobStatus(jobId, JobStatus.CANCELLED, 15_000);
      await waitForPendingCount(0);

      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 0,
        effects: 0,
        attempts: 1,
        deadLetters: 0,
      });
      const attempt = await pool.query<{ status: JobStatus }>(
        `SELECT status FROM job_attempts WHERE job_id = $1`,
        [jobId]
      );
      expect(attempt.rows.map(({ status }) => status)).toEqual([
        JobStatus.CANCELLED,
      ]);
    }, 30_000);

    it('recovers a pending execution after SIGKILL with duplicate execution but one idempotent effect', async () => {
      const firstWorker = startWorker({ WORKER_LEASE_DURATION_MS: '2000' });
      await waitForWorkerReady(firstWorker);
      const jobId = await submitJob({
        payload: {
          effectKey: 'kill-during-handler',
          effectBeforeDelay: true,
          delayFirstAttemptMs: 4_000,
        },
      });

      await waitForJobStatus(jobId, JobStatus.PROCESSING);
      await waitFor(
        () => counts(jobId),
        ({ executions, effects }) => executions === 1 && effects === 1,
        { label: 'first handler execution and effect' }
      );
      expect((await waitForPendingCount(1))[0]?.[3]).toBeGreaterThanOrEqual(1);

      await killWorker(firstWorker);
      expect((await readJob(jobId))?.status).toBe(JobStatus.PROCESSING);
      const pendingAfterKill = await pendingEntries();
      expect(pendingAfterKill).toHaveLength(1);
      const originalConsumer = pendingAfterKill[0]![1];

      const replacement = startWorker({ WORKER_LEASE_DURATION_MS: '2000' });
      await waitForWorkerReady(replacement);
      const reclaimed = await waitFor(
        pendingEntries,
        (entries) =>
          entries.length === 1 &&
          entries[0]![1] !== originalConsumer &&
          entries[0]![3] >= 2,
        { timeoutMs: 5_000, label: 'replacement XAUTOCLAIM ownership transfer' }
      );
      expect(reclaimed[0]![1]).not.toBe(originalConsumer);
      expect(reclaimed[0]![3]).toBeGreaterThanOrEqual(2);
      const recovered = await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
      expect(recovered.attempts).toBe(2);
      await waitForPendingCount(0);

      expect(await counts(jobId)).toEqual({
        executions: 2,
        effectAttempts: 2,
        effects: 1,
        attempts: 2,
        deadLetters: 0,
      });
      const attemptRows = await pool.query<{ status: JobStatus }>(
        `SELECT status
         FROM job_attempts
        WHERE job_id = $1
        ORDER BY attempt_number`,
        [jobId]
      );
      expect(attemptRows.rows.map((row) => row.status)).toEqual([
        JobStatus.FAILED,
        JobStatus.SUCCEEDED,
      ]);
    }, 30_000);

    it('drains an in-flight job to SUCCEEDED before a SIGTERM-ed worker exits', async () => {
      const worker = startWorker();
      await waitForWorkerReady(worker);
      const jobId = await submitJob({
        payload: { effectKey: 'graceful-drain', delayMs: 1_500 },
      });

      await waitForJobStatus(jobId, JobStatus.PROCESSING);
      await stopWorker(worker);

      const drained = await readJob(jobId);
      expect(drained?.status).toBe(JobStatus.SUCCEEDED);
      expect(drained?.attempts).toBe(1);
      expect(await pendingEntries()).toHaveLength(0);
      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 1,
        effects: 1,
        attempts: 1,
        deadLetters: 0,
      });
    }, 30_000);

    it('releases a non-cooperative job on bounded SIGTERM shutdown without consuming its attempt budget', async () => {
      const firstWorker = startWorker({
        WORKER_LEASE_DURATION_MS: '1000',
        TASKFLOW_TEST_SHUTDOWN_TIMEOUT_MS: '200',
      });
      await waitForWorkerReady(firstWorker);
      const jobId = await submitJob({
        maxAttempts: 1,
        payload: {
          effectKey: 'graceful-replacement',
          delayFirstAttemptMs: 10_000,
          ignoreCancellation: true,
        },
      });

      await waitForJobStatus(jobId, JobStatus.PROCESSING);
      await waitFor(
        () => counts(jobId),
        ({ executions }) => executions === 1,
        { label: 'noncooperative handler execution' }
      );
      expect(await waitForPendingCount(1)).toHaveLength(1);

      const stoppingAt = Date.now();
      await stopWorker(firstWorker);
      expect(Date.now() - stoppingAt).toBeLessThan(3_000);

      // The lease was handed back durably: no lease-expiry wait, no attempt
      // consumed (maxAttempts=1 would otherwise dead-letter), Redis ACKed.
      const released = await readJob(jobId);
      expect(released?.status).toBe(JobStatus.QUEUED);
      expect(released?.attempts).toBe(0);
      expect(await pendingEntries()).toHaveLength(0);

      // Redis loss after release is still recovered from the outbox.
      await redis.del(stream);

      const replacement = startWorker({
        WORKER_LEASE_DURATION_MS: '1000',
        TASKFLOW_TEST_DISPATCH_STALE_THRESHOLD_MS: '100',
      });
      await waitForWorkerReady(replacement);
      await waitForJobStatus(jobId, JobStatus.SUCCEEDED, 25_000);
      await waitForPendingCount(0);
      expect(await counts(jobId)).toEqual({
        executions: 2,
        effectAttempts: 1,
        effects: 1,
        attempts: 1,
        deadLetters: 0,
      });
    }, 40_000);

    it('leaves a delivery pending during transient lease-database failure and later completes it', async () => {
      const worker = startWorker({
        TASKFLOW_TEST_BEFORE_LEASE_DELAY_MS: '2000',
        WORKER_HEARTBEAT_INTERVAL_MS: '5000',
      });
      await waitForWorkerReady(worker);
      const jobId = await submitJob({
        payload: { effectKey: 'database-outage' },
      });

      const pendingBeforeFailure = await waitForPendingCount(1);
      expect(pendingBeforeFailure[0]?.[3]).toBeGreaterThanOrEqual(1);
      expect((await readJob(jobId))?.status).toBe(JobStatus.QUEUED);
      expect(await counts(jobId)).toMatchObject({ executions: 0, effects: 0 });
      docker('stop', 'postgres');

      await waitFor(
        async () => worker.output,
        (output) => output.includes('Unexpected delivery error'),
        { timeoutMs: 8_000, label: 'lease acquisition database error' }
      );
      expect((await pendingEntries()).length).toBe(1);

      await killWorker(worker);
      docker('up', '-d', '--wait', 'postgres');
      const queued = await waitForJobStatus(jobId, JobStatus.QUEUED, 10_000);
      expect(queued.attempts).toBe(0);
      expect(await counts(jobId)).toMatchObject({ executions: 0, effects: 0 });

      const replacement = startWorker();
      await waitForWorkerReady(replacement);
      await waitForJobStatus(jobId, JobStatus.SUCCEEDED, 20_000);
      await waitForPendingCount(0);
      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 1,
        effects: 1,
        attempts: 1,
        deadLetters: 0,
      });
    }, 40_000);

    it('recognizes a result committed before crash and replacement-ACKs without rerunning the handler', async () => {
      const crashingWorker = startWorker({
        TASKFLOW_TEST_CRASH_AFTER_COMMIT: 'true',
      });
      await waitForWorkerReady(crashingWorker);
      const jobId = await submitJob({
        payload: { effectKey: 'commit-before-ack' },
      });

      await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
      await waitForWorkerExit(crashingWorker);
      expect((await pendingEntries()).length).toBe(1);
      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 1,
        effects: 1,
        attempts: 1,
        deadLetters: 0,
      });

      const replacement = startWorker();
      await waitForWorkerReady(replacement);
      await waitForPendingCount(0);
      expect((await readJob(jobId))?.status).toBe(JobStatus.SUCCEEDED);
      expect(await counts(jobId)).toEqual({
        executions: 1,
        effectAttempts: 1,
        effects: 1,
        attempts: 1,
        deadLetters: 0,
      });
    }, 30_000);

    it('retains a due retry through worker shutdown and a workerless interval', async () => {
      const firstWorker = startWorker({
        JOB_RETRY_BASE_DELAY_MS: '1000',
        JOB_RETRY_MAX_DELAY_MS: '1000',
      });
      await waitForWorkerReady(firstWorker);
      const jobId = await submitJob({
        payload: { effectKey: 'workerless-retry', alwaysFail: true },
        maxAttempts: 2,
      });

      const scheduled = await waitForJobStatus(
        jobId,
        JobStatus.RETRY_SCHEDULED
      );
      expect(scheduled.attempts).toBe(1);
      await stopWorker(firstWorker);

      const successor = await pool.query<{
        status: string;
        available_at: Date;
      }>(
        `SELECT status, available_at
           FROM job_deliveries
          WHERE job_id = $1 AND attempt = 2`,
        [jobId]
      );
      expect(successor.rows[0]?.status).toBe('PENDING');

      const dueWaitMs = Math.max(
        0,
        (successor.rows[0]?.available_at.getTime() ?? Date.now()) -
          Date.now() +
          150
      );
      await sleep(dueWaitMs);
      expect(await readJob(jobId)).toMatchObject({
        status: JobStatus.RETRY_SCHEDULED,
        attempts: 1,
      });
      expect(await counts(jobId)).toMatchObject({ executions: 1, attempts: 1 });

      const replacement = startWorker();
      await waitForWorkerReady(replacement);
      const terminal = await waitForJobStatus(
        jobId,
        JobStatus.DEAD_LETTERED,
        20_000
      );
      expect(terminal.attempts).toBe(2);
      await waitForPendingCount(0);
      expect(await counts(jobId)).toEqual({
        executions: 2,
        effectAttempts: 0,
        effects: 0,
        attempts: 2,
        deadLetters: 1,
      });
    }, 35_000);

    it('derives exponential retries from execution and dead-letters only after exhaustion', async () => {
      const worker = startWorker();
      await waitForWorkerReady(worker);
      const jobId = await submitJob({
        payload: { effectKey: 'never-written', alwaysFail: true },
        maxAttempts: 3,
      });

      const terminal = await waitForJobStatus(
        jobId,
        JobStatus.DEAD_LETTERED,
        20_000
      );
      expect(terminal.attempts).toBe(3);
      await waitForPendingCount(0);
      expect(await counts(jobId)).toEqual({
        executions: 3,
        effectAttempts: 0,
        effects: 0,
        attempts: 3,
        deadLetters: 1,
      });

      const attempts = await pool.query<{
        attempt_number: number;
        status: JobStatus;
        started_at: Date;
        completed_at: Date;
      }>(
        `SELECT attempt_number, status, started_at, completed_at
         FROM job_attempts
        WHERE job_id = $1
        ORDER BY attempt_number`,
        [jobId]
      );
      expect(
        attempts.rows.map((row) => [row.attempt_number, row.status])
      ).toEqual([
        [1, JobStatus.FAILED],
        [2, JobStatus.FAILED],
        [3, JobStatus.FAILED],
      ]);
      expect(
        attempts.rows[1]!.started_at.getTime() -
          attempts.rows[0]!.completed_at.getTime()
      ).toBeGreaterThanOrEqual(250);
      expect(
        attempts.rows[2]!.started_at.getTime() -
          attempts.rows[1]!.completed_at.getTime()
      ).toBeGreaterThanOrEqual(550);

      const failureEvents = await pool.query<{ retry_delay_ms: number | null }>(
        `SELECT (metadata->>'retryDelayMs')::integer AS retry_delay_ms
         FROM job_events
        WHERE job_id = $1 AND event_type IN ('failed', 'dead_lettered')
        ORDER BY event_sequence`,
        [jobId]
      );
      expect(failureEvents.rows.map((row) => row.retry_delay_ms)).toEqual([
        300,
        600,
        null,
      ]);
    }, 30_000);
  });

  describe('bounded lifecycle retention', () => {
    it('purges expired terminal jobs while strictly protecting active leases, pending deliveries, and scheduled retries', async () => {
      const now = Date.now();
      const expiredCompletedAt = new Date(now - 40 * 86_400_000);
      const activeLeaseExpiry = new Date(now + 3_600_000);
      const futureScheduledAt = new Date(now + 600_000);

      // 1. Expired terminal job (safe to purge)
      const res1 = await pool.query<{ id: string }>(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, completed_at, created_at)
         VALUES ($1, $2, 'retention-test', '{}', 'SUCCEEDED', $3, $3)
         RETURNING id`,
        [userId, queueId, expiredCompletedAt]
      );
      const expiredJobId = res1.rows[0]!.id;

      // Create an active worker to own the active lease
      const workerRes = await pool.query<{ id: string }>(
        `INSERT INTO workers (worker_name, hostname, process_id, queues, status)
         VALUES ('retention-worker-active', 'test-host', 999, '{"default"}', 'ACTIVE')
         RETURNING id`
      );
      const activeWorkerId = workerRes.rows[0]!.id;

      // 2. Active lease job in PROCESSING (MUST NOT BE PURGED)
      const res2 = await pool.query<{ id: string }>(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, worker_id, lease_id, lease_expires_at, created_at)
         VALUES ($1, $2, 'retention-test', '{}', 'PROCESSING', $3, gen_random_uuid(), $4, $5)
         RETURNING id`,
        [userId, queueId, activeWorkerId, activeLeaseExpiry, expiredCompletedAt]
      );
      const activeLeaseJobId = res2.rows[0]!.id;

      // 3. Expired terminal job but has a PENDING outbox delivery (MUST NOT BE PURGED)
      const res3 = await pool.query<{ id: string }>(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, completed_at, created_at)
         VALUES ($1, $2, 'retention-test', '{}', 'SUCCEEDED', $3, $3)
         RETURNING id`,
        [userId, queueId, expiredCompletedAt]
      );
      const pendingDeliveryJobId = res3.rows[0]!.id;
      await pool.query(
        `INSERT INTO job_deliveries (job_id, queue_name, status, attempt, available_at)
         VALUES ($1, 'default', 'PENDING', 1, $2)`,
        [pendingDeliveryJobId, expiredCompletedAt]
      );

      // 4. Job with future scheduled retry (MUST NOT BE PURGED)
      const res4 = await pool.query<{ id: string }>(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, scheduled_at, created_at)
         VALUES ($1, $2, 'retention-test', '{}', 'RETRY_SCHEDULED', $3, $4)
         RETURNING id`,
        [userId, queueId, futureScheduledAt, expiredCompletedAt]
      );
      const scheduledJobId = res4.rows[0]!.id;

      // Run bounded job cleanup
      const deletedCount = await cleanupBoundedJobs(
        new Date(now - 30 * 86_400_000),
        50
      );
      expect(deletedCount).toBe(1);

      // Verify that expiredJobId is gone
      const checkExpired = await pool.query(
        `SELECT 1 FROM jobs WHERE id = $1`,
        [expiredJobId]
      );
      expect(checkExpired.rows).toHaveLength(0);

      // Verify protected jobs remain in the database
      const checkProtected = await pool.query<{ id: string }>(
        `SELECT id FROM jobs WHERE id = ANY($1) ORDER BY id`,
        [[activeLeaseJobId, pendingDeliveryJobId, scheduledJobId]]
      );
      expect(checkProtected.rows.map((r) => r.id).sort()).toEqual(
        [activeLeaseJobId, pendingDeliveryJobId, scheduledJobId].sort()
      );
    });

    it('purges dead-letter jobs and releases requeued replacement references safely', async () => {
      const now = Date.now();
      const expiredDate = new Date(now - 40 * 86_400_000);

      // Original job that dead-lettered
      const origRes = await pool.query<{ id: string }>(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, failed_at, created_at)
         VALUES ($1, $2, 'retention-dlq-orig', '{}', 'DEAD_LETTERED', $3, $3)
         RETURNING id`,
        [userId, queueId, expiredDate]
      );
      const origJobId = origRes.rows[0]!.id;

      // Requeued replacement job that also finished long ago
      const repRes = await pool.query<{ id: string }>(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, completed_at, created_at)
         VALUES ($1, $2, 'retention-dlq-rep', '{}', 'SUCCEEDED', $3, $3)
         RETURNING id`,
        [userId, queueId, expiredDate]
      );
      const repJobId = repRes.rows[0]!.id;

      // Dead letter record referencing original and requeued job
      await pool.query(
        `INSERT INTO dead_letter_jobs (
           original_job_id, user_id, queue_id, type, payload, attempts,
           failed_at, requeued, requeued_at, requeued_job_id
         ) VALUES (
           $1, $2, $3, 'retention-dlq-orig', '{}', 3,
           $4, true, $4, $5
         )`,
        [origJobId, userId, queueId, expiredDate, repJobId]
      );

      // First, purge expired dead letters
      const deletedDeadLetters = await cleanupBoundedDeadLetters(
        new Date(now - 30 * 86_400_000),
        50
      );
      expect(deletedDeadLetters).toBe(1);

      // The dead-letter record no longer protects either job, so both the
      // replacement (SUCCEEDED) and the original (DEAD_LETTERED) are purgeable.
      const deletedJobs = await cleanupBoundedJobs(
        new Date(now - 30 * 86_400_000),
        50
      );
      expect(deletedJobs).toBe(2);

      // Verify dead letter is deleted
      const checkDlq = await pool.query(
        `SELECT 1 FROM dead_letter_jobs WHERE original_job_id = $1`,
        [origJobId]
      );
      expect(checkDlq.rows).toHaveLength(0);

      // Verify runDatabaseRetention completes cleanly
      const summary = await runDatabaseRetention({
        deadLettersDays: 30,
        jobsCompletedDays: 30,
      });
      expect(summary.deletedDeadLetters).toBe(0);
      expect(summary.deletedJobs).toBe(0);
    });

    it('never purges workers that own active leases on nonterminal jobs', async () => {
      const now = Date.now();
      const expiredDate = new Date(now - 14 * 86_400_000);

      // Worker 1: stopped 14 days ago, but has an active job lease
      const w1Res = await pool.query<{ id: string }>(
        `INSERT INTO workers (worker_name, hostname, process_id, queues, status, stopped_at, last_heartbeat_at)
         VALUES ('active-lease-worker', 'test-host', 111, '{"default"}', 'STOPPED', $1, $1)
         RETURNING id`,
        [expiredDate]
      );
      const workerWithActiveLease = w1Res.rows[0]!.id;

      await pool.query(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, worker_id, lease_id, lease_expires_at, created_at)
         VALUES ($1, $2, 'active-lease-job', '{}', 'PROCESSING', $3, gen_random_uuid(), clock_timestamp() + interval '1 hour', $4)`,
        [userId, queueId, workerWithActiveLease, expiredDate]
      );

      // Worker 2: stopped 14 days ago, no active lease
      const w2Res = await pool.query<{ id: string }>(
        `INSERT INTO workers (worker_name, hostname, process_id, queues, status, stopped_at, last_heartbeat_at)
         VALUES ('idle-stopped-worker', 'test-host', 222, '{"default"}', 'STOPPED', $1, $1)
         RETURNING id`,
        [expiredDate]
      );
      const workerIdle = w2Res.rows[0]!.id;

      const deletedCount = await cleanupBoundedWorkers(
        new Date(now - 7 * 86_400_000),
        50
      );
      expect(deletedCount).toBe(1);

      const checkIdle = await pool.query(
        `SELECT 1 FROM workers WHERE id = $1`,
        [workerIdle]
      );
      expect(checkIdle.rows).toHaveLength(0);

      const checkActive = await pool.query(
        `SELECT 1 FROM workers WHERE id = $1`,
        [workerWithActiveLease]
      );
      expect(checkActive.rows).toHaveLength(1);
    });

    it('executes full retention across PostgreSQL and Redis with PEL boundary preservation', async () => {
      // 1. Add stream entries to Redis
      await redis.xadd(stream, '*', 'field', '1');
      await redis.xadd(stream, '*', 'field', '2');
      await redis.xadd(stream, '*', 'field', '3');

      // Create consumer group if not existing
      await redis
        .xgroup('CREATE', stream, WORKER_CONSUMER_GROUP, '0', 'MKSTREAM')
        .catch(() => {});

      // Read via XREADGROUP to create a pending entry in the PEL
      await redis.xreadgroup(
        'GROUP',
        WORKER_CONSUMER_GROUP,
        'test-consumer',
        'COUNT',
        '1',
        'STREAMS',
        stream,
        '>'
      );

      // 2. Execute full retention with redisStreamMaxLen: 1
      const report = await executeFullRetention({
        policy: {
          jobsCompletedDays: 30,
          redisStreamMaxLen: 1,
        },
        queues: ['default'],
      });

      // The stream has pending entries; trimStream must NOT trim past the oldest pending PEL ID
      const pel = (await redis.xpending(stream, WORKER_CONSUMER_GROUP)) as [
        number,
        string,
        string,
        unknown,
      ];
      expect(pel[0]).toBeGreaterThanOrEqual(1);

      // Stream length must retain at least the unacknowledged entry
      const streamLen = await redis.xlen(stream);
      expect(streamLen).toBeGreaterThanOrEqual(1);
      expect(report.trimmedRedisEntries.default).toBeDefined();
      expect(report.errors).toEqual([]);
    });

    const OLD = () => new Date(Date.now() - 40 * 86_400_000);
    const CUTOFF = () => new Date(Date.now() - 30 * 86_400_000);

    async function insertJob(
      status: string,
      options: { workerId?: string; completedAt?: Date | null } = {}
    ): Promise<string> {
      const old = OLD();
      const lease =
        status === 'PROCESSING' ? `, lease_id, lease_expires_at` : '';
      const leaseValues =
        status === 'PROCESSING'
          ? `, gen_random_uuid(), clock_timestamp() + interval '1 hour'`
          : '';
      const result = await pool.query<{ id: string }>(
        `INSERT INTO jobs (user_id, queue_id, type, payload, status, worker_id, completed_at, failed_at, created_at, attempts${lease})
         VALUES ($1, $2, 'retention-history', '{}', $3, $4, $5, $5, $6, 1${leaseValues})
         RETURNING id`,
        [
          userId,
          queueId,
          status,
          options.workerId ?? null,
          options.completedAt === undefined ? old : options.completedAt,
          old,
        ]
      );
      return result.rows[0]!.id;
    }

    async function insertHistory(
      jobId: string,
      workerId: string | null,
      jobStatus: string
    ): Promise<void> {
      await pool.query(
        `INSERT INTO job_attempts (job_id, attempt_number, worker_id, started_at, status)
         VALUES ($1, 1, $2, $3, $4)`,
        [
          jobId,
          workerId,
          OLD(),
          jobStatus === 'PROCESSING' ? 'PROCESSING' : 'SUCCEEDED',
        ]
      );
      await pool.query(
        `INSERT INTO job_events (job_id, event_type, to_status, event_sequence, worker_id, created_at)
         VALUES ($1, 'completed', $2, 1, $3, $4)`,
        [jobId, jobStatus, workerId, OLD()]
      );
    }

    async function insertWorker(name: string): Promise<string> {
      const old = OLD();
      const result = await pool.query<{ id: string }>(
        `INSERT INTO workers (worker_name, hostname, process_id, queues, status, stopped_at, last_heartbeat_at)
         VALUES ($1, 'test-host', 4242, '{"default"}', 'STOPPED', $2, $2)
         RETURNING id`,
        [name, old]
      );
      return result.rows[0]!.id;
    }

    it('purges a stopped worker that retained history still references, clearing the references', async () => {
      const workerId = await insertWorker('history-worker');
      const jobId = await insertJob('SUCCEEDED', { workerId });
      await insertHistory(jobId, workerId, 'SUCCEEDED');

      // Before migration 0009 this raised a foreign-key violation (23503).
      expect(await cleanupBoundedWorkers(CUTOFF(), 50)).toBe(1);

      const refs = await pool.query<{ tbl: string; worker_id: string | null }>(
        `SELECT 'jobs' AS tbl, worker_id FROM jobs WHERE id = $1
         UNION ALL SELECT 'job_attempts', worker_id FROM job_attempts WHERE job_id = $1
         UNION ALL SELECT 'job_events', worker_id FROM job_events WHERE job_id = $1`,
        [jobId]
      );
      expect(refs.rows).toHaveLength(3);
      expect(refs.rows.every((row) => row.worker_id === null)).toBe(true);
    });

    it('keeps a PUBLISHED delivery while its job is live, and purges it once the job is terminal', async () => {
      const liveJobId = await insertJob('QUEUED', { completedAt: null });
      const doneJobId = await insertJob('SUCCEEDED');
      for (const jobId of [liveJobId, doneJobId]) {
        await pool.query(
          `INSERT INTO job_deliveries (job_id, queue_name, status, attempt, available_at, published_at)
           VALUES ($1, 'default', 'PUBLISHED', 1, $2, $2)`,
          [jobId, OLD()]
        );
      }

      expect(await cleanupBoundedJobDeliveries(CUTOFF(), 50)).toBe(1);

      const remaining = await pool.query<{ job_id: string }>(
        `SELECT job_id FROM job_deliveries`
      );
      // The QUEUED job's row is the evidence the stale-delivery scan needs to
      // republish it if its Redis entry is lost.
      expect(remaining.rows.map((row) => row.job_id)).toEqual([liveJobId]);
    });

    it('never purges events or attempts of a running job, only of terminal ones', async () => {
      const runningWorker = await pool.query<{ id: string }>(
        `INSERT INTO workers (worker_name, hostname, process_id, queues, status)
         VALUES ('running-worker', 'test-host', 4343, '{"default"}', 'ACTIVE') RETURNING id`
      );
      const runningJobId = await insertJob('PROCESSING', {
        workerId: runningWorker.rows[0]!.id,
        completedAt: null,
      });
      const doneJobId = await insertJob('SUCCEEDED');
      await insertHistory(
        runningJobId,
        runningWorker.rows[0]!.id,
        'PROCESSING'
      );
      await insertHistory(doneJobId, null, 'SUCCEEDED');

      expect(await cleanupBoundedJobEvents(CUTOFF(), 50)).toBe(1);
      expect(await cleanupBoundedJobAttempts(CUTOFF(), 50)).toBe(1);

      const events = await pool.query<{ job_id: string }>(
        `SELECT job_id FROM job_events`
      );
      const attempts = await pool.query<{ job_id: string }>(
        `SELECT job_id FROM job_attempts`
      );
      // Completing the running job needs its open attempt row.
      expect(events.rows.map((row) => row.job_id)).toEqual([runningJobId]);
      expect(attempts.rows.map((row) => row.job_id)).toEqual([runningJobId]);
    });

    it('purges a DEAD_LETTERED job only after its dead-letter record is gone', async () => {
      const jobId = await insertJob('DEAD_LETTERED');
      await pool.query(
        `INSERT INTO dead_letter_jobs (original_job_id, user_id, queue_id, type, payload, attempts, failed_at)
         VALUES ($1, $2, $3, 'retention-history', '{}', 3, $4)`,
        [jobId, userId, queueId, OLD()]
      );

      // Protected while the dead-letter record exists.
      expect(await cleanupBoundedJobs(CUTOFF(), 50)).toBe(0);

      expect(await cleanupBoundedDeadLetters(CUTOFF(), 50)).toBe(1);
      expect(await cleanupBoundedJobs(CUTOFF(), 50)).toBe(1);
      const left = await pool.query(`SELECT 1 FROM jobs WHERE id = $1`, [
        jobId,
      ]);
      expect(left.rows).toHaveLength(0);
    });

    it('purges across every table in one runDatabaseRetention pass with no step errors', async () => {
      const workerId = await insertWorker('full-pass-worker');
      const jobId = await insertJob('SUCCEEDED', { workerId });
      await insertHistory(jobId, workerId, 'SUCCEEDED');
      await pool.query(
        `INSERT INTO job_deliveries (job_id, queue_name, status, attempt, available_at, published_at)
         VALUES ($1, 'default', 'PUBLISHED', 1, $2, $2)`,
        [jobId, OLD()]
      );

      const summary = await runDatabaseRetention({
        jobsCompletedDays: 30,
        jobEventsDays: 30,
        jobAttemptsDays: 30,
        deliveriesDays: 30,
        workersDays: 30,
      });

      expect(summary.errors).toEqual([]);
      expect(summary).toMatchObject({
        deletedJobs: 1,
        deletedJobEvents: 1,
        deletedJobAttempts: 1,
        deletedJobDeliveries: 1,
        deletedWorkers: 1,
      });
    });

    it('lets exactly one of two concurrent retention schedulers run, using the real Redis lock', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const emptyReport = {
        deletedJobs: 0,
        deletedJobEvents: 0,
        deletedJobAttempts: 0,
        deletedDeadLetters: 0,
        deletedJobDeliveries: 0,
        deletedWorkers: 0,
        deletedIdempotencyKeys: 0,
        deletedAuditLogs: 0,
        trimmedRedisEntries: {},
        errors: [],
        completedAt: new Date().toISOString(),
      };
      let executions = 0;
      const run = async () => {
        executions += 1;
        await gate;
        return emptyReport;
      };
      const first = new RetentionScheduler({ run, getRedis: () => redis });
      const second = new RetentionScheduler({ run, getRedis: () => redis });

      const firstRun = first.runOnce();
      await waitFor(
        async () => redis.exists(RETENTION_LOCK_KEY),
        (held) => held === 1,
        { label: 'retention lock held' }
      );
      const secondOutcome = await second.runOnce();

      expect(secondOutcome).toEqual({ ran: false, reason: 'LOCKED' });
      release();
      await expect(firstRun).resolves.toMatchObject({ ran: true });
      expect(executions).toBe(1);
      // The owner released the lock, so the next run is admitted.
      expect(await redis.exists(RETENTION_LOCK_KEY)).toBe(0);
    });
  });

  describe('priority dispatch window', () => {
    /** Tags of SUCCEEDED jobs, in the order they finished. */
    async function completionOrder(): Promise<string[]> {
      const result = await pool.query<{ tag: string }>(
        `SELECT payload->>'effectKey' AS tag
           FROM jobs
          WHERE status = 'SUCCEEDED'
          ORDER BY completed_at, id`
      );
      return result.rows.map((row) => row.tag);
    }

    async function waitForSucceeded(count: number): Promise<void> {
      await waitFor(
        async () => {
          const result = await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM jobs WHERE status = 'SUCCEEDED'`
          );
          return result.rows[0]!.count;
        },
        (done) => done === count,
        { timeoutMs: 40_000, label: `${count} jobs succeeded` }
      );
    }

    const submit = (
      tag: string,
      priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW',
      delayMs = 100
    ): Promise<string> =>
      submitJob({ priority, payload: { effectKey: tag, delayMs } });

    it('releases a queued backlog strictly by priority, then by age', async () => {
      // Queue the backlog while NO worker runs: the outbox holds it all.
      await submit('low-1', 'LOW');
      await submit('low-2', 'LOW');
      await submit('normal-1', 'NORMAL');
      await submit('low-3', 'LOW');
      await submit('high-1', 'HIGH');
      await submit('critical-1', 'CRITICAL');
      await submit('normal-2', 'NORMAL');

      const worker = startWorker({
        DISPATCH_MAX_IN_FLIGHT_PER_QUEUE: '1',
        WORKER_CONCURRENCY: '1',
      });
      await waitForWorkerReady(worker);
      await waitForSucceeded(7);

      expect(await completionOrder()).toEqual([
        'critical-1',
        'high-1',
        'normal-1',
        'normal-2',
        'low-1',
        'low-2',
        'low-3',
      ]);
    }, 60_000);

    it('lets a late CRITICAL job overtake a backlog that is already waiting', async () => {
      const worker = startWorker({
        DISPATCH_MAX_IN_FLIGHT_PER_QUEUE: '1',
        WORKER_CONCURRENCY: '1',
      });
      await waitForWorkerReady(worker);

      const lowTags = Array.from({ length: 10 }, (_, i) => `low-${i}`);
      const firstJobId = await submit(lowTags[0]!, 'LOW', 300);
      for (const tag of lowTags.slice(1)) await submit(tag, 'LOW', 300);
      await waitForJobStatus(firstJobId, JobStatus.PROCESSING);
      await submit('critical-late', 'CRITICAL', 300);

      await waitForSucceeded(11);

      const order = await completionOrder();
      // At most the job already running and one already published can finish
      // first; the other eight low jobs must still be behind it.
      expect(order.indexOf('critical-late')).toBeLessThanOrEqual(2);
    }, 60_000);

    it('is FIFO without the window: a late CRITICAL job waits behind the published backlog', async () => {
      const worker = startWorker({
        DISPATCH_MAX_IN_FLIGHT_PER_QUEUE: '0',
        WORKER_CONCURRENCY: '1',
      });
      await waitForWorkerReady(worker);

      const lowTags = Array.from({ length: 10 }, (_, i) => `low-${i}`);
      const firstJobId = await submit(lowTags[0]!, 'LOW', 300);
      for (const tag of lowTags.slice(1)) await submit(tag, 'LOW', 300);
      await waitForJobStatus(firstJobId, JobStatus.PROCESSING);
      // Claims are priority-ordered either way, so the CRITICAL job must
      // arrive only after every LOW job has really been published to Redis.
      await waitFor(
        async () => {
          const result = await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM job_deliveries
              WHERE status = 'PUBLISHED'`
          );
          return result.rows[0]!.count;
        },
        (published) => published === lowTags.length,
        { label: 'all low jobs published' }
      );
      await submit('critical-late', 'CRITICAL', 300);

      await waitForSucceeded(11);

      // Control for the test above: with everything already in Redis the
      // stream's FIFO order wins, so the same scenario ends with CRITICAL last
      // (or very nearly). This is the behaviour the window exists to fix.
      const order = await completionOrder();
      expect(order.indexOf('critical-late')).toBeGreaterThanOrEqual(8);
    }, 60_000);
  });
});
