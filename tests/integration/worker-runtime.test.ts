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

import { closeConnection } from '../../packages/database/src';
import {
  closeRedisConnection,
  getStreamKey,
  WORKER_CONSUMER_GROUP,
} from '../../packages/queue/src';
import {
  JobStatus,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '../../packages/types/src';

const root = path.resolve(__dirname, '../..');
const composeFile = path.join(__dirname, 'worker-runtime.compose.yml');
const composeArgs = ['compose', '-p', 'taskflow-worker-it', '-f', composeFile];
const databaseUrl =
  'postgresql://taskflow_test:taskflow_test@127.0.0.1:55439/taskflow_test';
const redisUrl = 'redis://127.0.0.1:56389';
const jwtSecret = 'taskflow-integration-secret-at-least-32-characters';
const userId = '00000000-0000-4000-8000-000000000001';
const queueId = '20000000-0000-4000-8000-000000000001';
const stream = getStreamKey('default');

interface RuntimeProcess {
  child: ChildProcess;
  output: string;
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
  scheduled_at: Date;
  failed_at: Date | null;
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
  const child = spawn(
    'pnpm',
    [
      '--dir',
      'apps/worker',
      'exec',
      'tsx',
      '--tsconfig',
      '../../tests/tsconfig.integration.json',
      'src/index.ts',
    ],
    {
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
    }
  );

  const runtime: RuntimeProcess = { child, output: '' };
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

async function waitForWorkerExit(runtime: RuntimeProcess): Promise<void> {
  await waitFor(
    async () => ({
      exitCode: runtime.child.exitCode,
      signalCode: runtime.child.signalCode,
    }),
    ({ exitCode, signalCode }) => exitCode !== null || signalCode !== null,
    { timeoutMs: 10_000, label: `worker exit; output=${runtime.output}` }
  );
  workerProcesses.delete(runtime);
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

  await waitForWorkerExit(runtime).catch(() => undefined);
  workerProcesses.delete(runtime);
}

async function killAllWorkers(): Promise<void> {
  await Promise.all([...workerProcesses].map(killWorker));
}

async function submitJob(
  options: {
    type?: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
  } = {}
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { 'x-api-key': 'test-api-key' },
    payload: {
      type: options.type ?? 'test-idempotent',
      queue: 'default',
      payload: options.payload ?? {},
      ...(options.maxAttempts === undefined
        ? {}
        : { maxAttempts: options.maxAttempts }),
    },
  });

  expect(response.statusCode, response.body).toBe(201);
  const submitted = response.json<{ id: string; status: JobStatus }>();
  expect(submitted.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(submitted.status).toBe(JobStatus.QUEUED);
  return submitted.id;
}

async function readJob(jobId: string): Promise<JobRow | undefined> {
  const result = await pool.query<JobRow>(
    `SELECT status, attempts, result, error, scheduled_at, failed_at
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
  effects: number;
  attempts: number;
  deadLetters: number;
}> {
  const result = await pool.query<{
    executions: string;
    effects: string;
    attempts: string;
    dead_letters: string;
  }>(
    `SELECT
       (SELECT count(*) FROM test_handler_executions WHERE job_id = $1) AS executions,
       (SELECT count(*) FROM test_effects WHERE job_id = $1) AS effects,
       (SELECT count(*) FROM job_attempts WHERE job_id = $1) AS attempts,
       (SELECT count(*) FROM dead_letter_jobs WHERE original_job_id = $1) AS dead_letters`,
    [jobId]
  );
  const row = result.rows[0]!;
  return {
    executions: Number(row.executions),
    effects: Number(row.effects),
    attempts: Number(row.attempts),
    deadLetters: Number(row.dead_letters),
  };
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
  for (const migration of [
    '0001_initial_schema.sql',
    '0002_performance_indexes.sql',
  ]) {
    docker(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'taskflow_test',
      '-d',
      'taskflow_test',
      '-f',
      `/migrations/${migration}`
    );
  }

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
     );`
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES ($1, 'worker-it@example.test', 'unused')`,
    [userId]
  );
  await pool.query(
    `INSERT INTO queues (id, name, display_name)
     VALUES ($1, 'default', 'Default')`,
    [queueId]
  );
  const { createApp } = await import('../../apps/api/src/app');
  app = (await createApp()) as ApiTestApp;
}, 60_000);

beforeEach(async () => {
  await killAllWorkers();
  docker('up', '-d', '--wait');
  await redis.flushall();
  await pool.query(
    `TRUNCATE TABLE
       idempotency_keys,
       dead_letter_jobs,
       job_events,
       job_attempts,
       test_handler_executions,
       test_effects,
       jobs,
       workers
     RESTART IDENTITY CASCADE`
  );
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
  it('takes an API-created job through the shared envelope to durable SUCCEEDED before XACK', async () => {
    const worker = startWorker({
      TASKFLOW_TEST_AFTER_COMMIT_DELAY_MS: '1500',
    });
    await waitForWorkerReady(worker);

    const jobId = await submitJob({
      type: 'process-data',
      payload: {
        operation: 'transform',
        data: [{ id: 'one', value: 1 }],
      },
    });

    expect(await messageEnvelope(jobId)).toMatchObject({
      schemaVersion: REDIS_JOB_MESSAGE_VERSION,
      jobId,
      queue: 'default',
      attempt: 1,
    });

    const job = await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
    expect(job.result).toMatchObject({
      operation: 'transform',
      recordsProcessed: 1,
    });

    // The failpoint runs after the transaction resolves and before XACK.
    expect((await waitForPendingCount(1))[0]?.[3]).toBeGreaterThanOrEqual(1);

    const eventRows = await pool.query<{ to_status: JobStatus }>(
      `SELECT to_status
         FROM job_events
        WHERE job_id = $1
        ORDER BY created_at, id`,
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

    await waitForPendingCount(0);
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
      { timeoutMs: 5_000, label: 'replacement XCLAIM ownership transfer' }
    );
    expect(reclaimed[0]![1]).not.toBe(originalConsumer);
    expect(reclaimed[0]![3]).toBeGreaterThanOrEqual(2);
    const recovered = await waitForJobStatus(jobId, JobStatus.SUCCEEDED);
    expect(recovered.attempts).toBe(2);
    await waitForPendingCount(0);

    expect(await counts(jobId)).toEqual({
      executions: 2,
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
      effects: 1,
      attempts: 1,
      deadLetters: 0,
    });
  }, 30_000);

  it('derives exponential retries from execution and dead-letters only after exhaustion', async () => {
    const worker = startWorker();
    await waitForWorkerReady(worker);
    const jobId = await submitJob({
      payload: { effectKey: 'never-written', alwaysFail: true },
      maxAttempts: 3,
    });

    const firstRetry = await waitForJobStatus(
      jobId,
      JobStatus.RETRY_SCHEDULED,
      10_000
    );
    expect(firstRetry.attempts).toBe(1);
    expect(firstRetry.failed_at).not.toBeNull();
    expect(
      firstRetry.scheduled_at.getTime() - firstRetry.failed_at!.getTime()
    ).toBeGreaterThanOrEqual(250);
    expect((await pendingEntries()).length).toBe(1);

    const terminal = await waitForJobStatus(
      jobId,
      JobStatus.DEAD_LETTERED,
      20_000
    );
    expect(terminal.attempts).toBe(3);
    await waitForPendingCount(0);
    expect(await counts(jobId)).toEqual({
      executions: 3,
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
        ORDER BY created_at, id`,
      [jobId]
    );
    expect(failureEvents.rows.map((row) => row.retry_delay_ms)).toEqual([
      300,
      600,
      null,
    ]);
  }, 30_000);
});
