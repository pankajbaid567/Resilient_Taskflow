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

import { closeConnection, hashApiKey } from '@taskflow/database';
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

    it('bounds SIGTERM shutdown and redispatches an expired PROCESSING job after Redis loss', async () => {
      const firstWorker = startWorker({
        WORKER_LEASE_DURATION_MS: '1000',
        TASKFLOW_TEST_SHUTDOWN_TIMEOUT_MS: '200',
      });
      await waitForWorkerReady(firstWorker);
      const jobId = await submitJob({
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
      expect((await readJob(jobId))?.status).toBe(JobStatus.PROCESSING);
      expect(await pendingEntries()).toHaveLength(1);
      expect(await redis.del(stream)).toBe(1);

      const replacement = startWorker({
        WORKER_LEASE_DURATION_MS: '1000',
        TASKFLOW_TEST_DISPATCH_STALE_THRESHOLD_MS: '100',
      });
      await waitForWorkerReady(replacement);
      await waitForJobStatus(jobId, JobStatus.SUCCEEDED, 20_000);
      await waitForPendingCount(0);
      expect(await counts(jobId)).toEqual({
        executions: 2,
        effectAttempts: 1,
        effects: 1,
        attempts: 2,
        deadLetters: 0,
      });
    }, 30_000);

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
});
