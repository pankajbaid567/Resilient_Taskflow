import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';

import { closeConnection } from '@taskflow/database';
import { closeRedisConnection, getRedisClient } from '@taskflow/queue';
import Redis from 'ioredis';
import { Pool, type QueryResult } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../apps/api/src/app';

const root = path.resolve(__dirname, '../..');
const composeFile = path.join(__dirname, 'api-runtime.compose.yml');
const composeArgs = ['compose', '-p', 'taskflow-api-it', '-f', composeFile];
const databaseUrl =
  'postgresql://taskflow_test:taskflow_test@127.0.0.1:55459/taskflow_test';
const redisUrl = 'redis://127.0.0.1:56399';
const jwtSecret = 'taskflow-api-integration-secret-at-least-32-characters';
const apiKeySalt = 'taskflow-api-integration-key-salt';

const userAId = '10000000-0000-4000-8000-000000000001';
const userBId = '10000000-0000-4000-8000-000000000002';
const adminId = '10000000-0000-4000-8000-000000000003';
const inactiveUserId = '10000000-0000-4000-8000-000000000004';
const defaultQueueId = '20000000-0000-4000-8000-000000000001';
const priorityQueueId = '20000000-0000-4000-8000-000000000002';
const inactiveQueueId = '20000000-0000-4000-8000-000000000003';

const validApiKey = 'api-it-user-a-secret';
const userBApiKey = 'api-it-user-b-secret';
const adminApiKey = 'api-it-admin-secret';
const revokedApiKey = 'api-it-revoked-secret';
const expiredApiKey = 'api-it-expired-secret';
const inactiveApiKey = 'api-it-inactive-secret';

type App = Awaited<ReturnType<typeof createApp>>;

interface InjectResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json<T = unknown>(): T;
}

interface SubmittedJob {
  id: string;
  status: string;
  type: string;
  queue: string;
  maxAttempts: number;
}

type TestHttpMethod = 'GET' | 'POST' | 'DELETE';

let app: App | undefined;
let pool: Pool | undefined;
let redis: Redis | undefined;

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
      env: integrationEnvironment(),
    }
  );

  if (result.status !== 0) {
    throw new Error(
      `database migration runner failed:\n${result.stdout}\n${result.stderr}`
    );
  }
}

function integrationEnvironment(
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MIN: '0',
    DATABASE_POOL_MAX: '6',
    REDIS_URL: redisUrl,
    REDIS_MAX_RETRIES: '0',
    REDIS_RETRY_DELAY_MS: '50',
    JWT_SECRET: jwtSecret,
    API_KEY_HASH_SALT: apiKeySalt,
    ENABLE_TRACING: 'false',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

function apiKeyHash(apiKey: string): string {
  return createHmac('sha256', apiKeySalt).update(apiKey, 'utf8').digest('hex');
}

async function resetAndSeed(): Promise<void> {
  if (!pool || !redis) throw new Error('integration services not initialized');

  await pool.query(`
    TRUNCATE TABLE
      api_keys,
      idempotency_keys,
      job_deliveries,
      job_events,
      job_attempts,
      dead_letter_jobs,
      jobs,
      workers,
      queues,
      users
    CASCADE
  `);
  await redis.flushdb();

  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, is_active)
     VALUES
       ($1, 'user-a@example.test', 'not-used', 'user', true),
       ($2, 'user-b@example.test', 'not-used', 'user', true),
       ($3, 'admin@example.test', 'not-used', 'admin', true),
       ($4, 'inactive@example.test', 'not-used', 'admin', false)`,
    [userAId, userBId, adminId, inactiveUserId]
  );

  // Only keyed HMAC fingerprints enter PostgreSQL; no plaintext credential is
  // inserted into api_keys or the deprecated users.api_key columns.
  await pool.query(
    `INSERT INTO api_keys
       (user_id, name, key_hash, created_at, expires_at, revoked_at)
     VALUES
       ($1, 'user-a', $5, clock_timestamp(), NULL, NULL),
       ($2, 'user-b', $6, clock_timestamp(), NULL, NULL),
       ($3, 'admin', $7, clock_timestamp(), NULL, NULL),
       ($1, 'revoked', $8, clock_timestamp() - interval '2 hours', NULL,
        clock_timestamp() - interval '1 hour'),
       ($1, 'expired', $9, clock_timestamp() - interval '2 hours',
        clock_timestamp() - interval '1 hour', NULL),
       ($4, 'inactive-owner', $10, clock_timestamp(), NULL, NULL)`,
    [
      userAId,
      userBId,
      adminId,
      inactiveUserId,
      apiKeyHash(validApiKey),
      apiKeyHash(userBApiKey),
      apiKeyHash(adminApiKey),
      apiKeyHash(revokedApiKey),
      apiKeyHash(expiredApiKey),
      apiKeyHash(inactiveApiKey),
    ]
  );

  await pool.query(
    `INSERT INTO queues
       (id, name, display_name, max_retry_attempts, default_timeout_ms,
        is_active)
     VALUES
       ($1, 'default', 'Default', 4, 4321, true),
       ($2, 'priority.jobs', 'Priority jobs', 7, 8765, true),
       ($3, 'inactive', 'Inactive', 2, 2000, false)`,
    [defaultQueueId, priorityQueueId, inactiveQueueId]
  );
}

function authHeaders(
  apiKey: string = validApiKey,
  extra: Record<string, string> = {}
): Record<string, string> {
  return { 'x-api-key': apiKey, ...extra };
}

function submissionBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'api-integration',
    payload: { value: 1 },
    ...overrides,
  };
}

async function inject(options: {
  method: TestHttpMethod;
  url: string;
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
}): Promise<InjectResponse> {
  if (!app) throw new Error('Fastify app not initialized');
  return app.inject(options) as Promise<InjectResponse>;
}

async function submitJob(
  options: {
    apiKey?: string;
    idempotencyKey?: string;
    body?: Record<string, unknown>;
  } = {}
): Promise<InjectResponse> {
  return inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: authHeaders(
      options.apiKey,
      options.idempotencyKey
        ? { 'idempotency-key': options.idempotencyKey }
        : {}
    ),
    payload: options.body ?? submissionBody(),
  });
}

function encodeJwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signJwt(options: {
  subject: string;
  algorithm?: 'HS256' | 'HS512';
  claims?: Record<string, unknown>;
}): string {
  const algorithm = options.algorithm ?? 'HS256';
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encodeJwtPart({ alg: algorithm, typ: 'JWT' })}.${encodeJwtPart(
    {
      iss: 'taskflow-api',
      aud: 'taskflow-clients',
      sub: options.subject,
      iat: now,
      exp: now + 300,
      ...options.claims,
    }
  )}`;
  const digest = algorithm === 'HS256' ? 'sha256' : 'sha512';
  const signature = createHmac(digest, jwtSecret)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

async function queryOne<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<T> {
  if (!pool) throw new Error('PostgreSQL pool not initialized');
  const result: QueryResult<T> = await pool.query(text, values);
  const row = result.rows[0];
  if (!row) throw new Error(`query returned no row: ${text}`);
  return row;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to reserve a test port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('API child exited before becoming ready');
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `API child did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

beforeAll(async () => {
  docker('down', '--volumes', '--remove-orphans');
  docker('up', '-d', '--wait');
  migrateDatabase();

  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  redis = new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);
  await Promise.all([pool.query('SELECT 1'), redis.ping()]);

  app = await createApp({ enableSwagger: false, trustProxy: false });
  await app.ready();
}, 60_000);

beforeEach(resetAndSeed);

afterAll(async () => {
  await app?.close();
  await closeRedisConnection().catch(() => undefined);
  await closeConnection().catch(() => undefined);
  if (redis && redis.status !== 'end')
    await redis.quit().catch(() => undefined);
  await pool?.end();
  docker('down', '--volumes', '--remove-orphans');
}, 30_000);

describe.sequential('API runtime against PostgreSQL and Redis', () => {
  it('requires explicitly seeded, active, unexpired and unrevoked credentials', async () => {
    const implicit = await inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: authHeaders('test-api-key'),
    });
    expect(implicit.statusCode).toBe(401);

    const valid = await inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: authHeaders(),
    });
    expect(valid.statusCode, valid.body).toBe(200);

    for (const deniedKey of [
      revokedApiKey,
      expiredApiKey,
      inactiveApiKey,
      'not-seeded',
    ]) {
      const response = await inject({
        method: 'GET',
        url: '/api/v1/jobs',
        headers: authHeaders(deniedKey),
      });
      expect(response.statusCode, deniedKey).toBe(401);
    }

    const stored = await queryOne<{
      plaintext_count: number;
      fingerprint_count: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE u.api_key IS NOT NULL)::int AS plaintext_count,
         count(k.key_hash)::int AS fingerprint_count
       FROM users u LEFT JOIN api_keys k ON k.user_id = u.id`
    );
    expect(stored).toEqual({ plaintext_count: 0, fingerprint_count: 6 });
  });

  it('accepts only HS256 UUID subjects and resolves mutable identity from PostgreSQL', async () => {
    const forgedClaimsToken = signJwt({
      subject: userAId,
      claims: { email: 'forged@example.test', role: 'admin' },
    });
    const list = await inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: { authorization: `Bearer ${forgedClaimsToken}` },
    });
    expect(list.statusCode, list.body).toBe(200);

    const adminOnly = await inject({
      method: 'POST',
      url: `/api/v1/workers/${adminId}/stop`,
      headers: { authorization: `Bearer ${forgedClaimsToken}` },
    });
    expect(adminOnly.statusCode, adminOnly.body).toBe(403);

    const invalidSubject = await inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: {
        authorization: `Bearer ${signJwt({ subject: 'not-a-uuid' })}`,
      },
    });
    expect(invalidSubject.statusCode).toBe(401);

    const wrongAlgorithm = await inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: {
        authorization: `Bearer ${signJwt({
          subject: userAId,
          algorithm: 'HS512',
        })}`,
      },
    });
    expect(wrongAlgorithm.statusCode).toBe(401);

    if (!pool) throw new Error('PostgreSQL pool not initialized');
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [
      userAId,
    ]);
    const deactivated = await inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: { authorization: `Bearer ${forgedClaimsToken}` },
    });
    expect(deactivated.statusCode).toBe(401);
  });

  it('rejects malformed identifiers, queries and bounded job fields at HTTP ingress', async () => {
    const invalidRequests: Array<{
      method: TestHttpMethod;
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: 'GET', url: '/api/v1/jobs/not-a-uuid' },
      { method: 'GET', url: '/api/v1/jobs?limit=0' },
      { method: 'GET', url: '/api/v1/jobs?limit=101' },
      { method: 'GET', url: '/api/v1/jobs?offset=-1' },
      { method: 'GET', url: '/api/v1/jobs?limit=abc' },
      { method: 'GET', url: '/api/v1/jobs?unexpected=true' },
      {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: submissionBody({ maxAttempts: 0 }),
      },
      {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: submissionBody({ maxAttempts: 11 }),
      },
      {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: submissionBody({ timeoutMs: 0 }),
      },
      {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: submissionBody({ timeoutMs: 86_400_001 }),
      },
      {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: submissionBody({ queue: 'Invalid Queue' }),
      },
      {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: submissionBody({
          tags: Array.from({ length: 33 }, () => 'x'),
        }),
      },
      {
        method: 'POST',
        url: '/api/v1/jobs',
        payload: submissionBody({ tags: [''] }),
      },
    ];

    for (const request of invalidRequests) {
      const response = await inject({ ...request, headers: authHeaders() });
      expect(
        response.statusCode,
        `${request.method} ${request.url}: ${response.body}`
      ).toBe(400);
    }

    const missingQueue = await submitJob({
      body: submissionBody({ queue: 'missing' }),
    });
    expect(missingQueue.statusCode).toBe(404);

    const inactiveQueue = await submitJob({
      body: submissionBody({ queue: 'inactive' }),
    });
    expect(inactiveQueue.statusCode).toBe(404);

    expect(
      (
        await queryOne<{ count: number }>(
          'SELECT count(*)::int AS count FROM jobs'
        )
      ).count
    ).toBe(0);
  });

  it('uses the real queue identity and queue retry/timeout defaults', async () => {
    const defaultResponse = await submitJob();
    expect(defaultResponse.statusCode, defaultResponse.body).toBe(201);
    const defaultJob = defaultResponse.json<SubmittedJob>();
    expect(defaultJob).toMatchObject({
      status: 'QUEUED',
      queue: 'default',
      maxAttempts: 4,
    });

    const priorityResponse = await submitJob({
      body: submissionBody({ queue: 'priority.jobs', type: 'priority-work' }),
    });
    expect(priorityResponse.statusCode, priorityResponse.body).toBe(201);
    const priorityJob = priorityResponse.json<SubmittedJob>();
    expect(priorityJob).toMatchObject({
      status: 'QUEUED',
      queue: 'priority.jobs',
      maxAttempts: 7,
    });

    const rows = await queryOne<{
      default_queue_id: string;
      default_timeout: number;
      priority_queue_id: string;
      priority_timeout: number;
      pending_deliveries: number;
    }>(
      `SELECT
         max(queue_id::text) FILTER (WHERE id = $1) AS default_queue_id,
         max(timeout_ms) FILTER (WHERE id = $1)::int AS default_timeout,
         max(queue_id::text) FILTER (WHERE id = $2) AS priority_queue_id,
         max(timeout_ms) FILTER (WHERE id = $2)::int AS priority_timeout,
         (SELECT count(*)::int FROM job_deliveries
           WHERE job_id IN ($1, $2) AND status = 'PENDING') AS pending_deliveries
       FROM jobs`,
      [defaultJob.id, priorityJob.id]
    );
    expect(rows).toEqual({
      default_queue_id: defaultQueueId,
      default_timeout: 4321,
      priority_queue_id: priorityQueueId,
      priority_timeout: 8765,
      pending_deliveries: 2,
    });

    const fetched = await inject({
      method: 'GET',
      url: `/api/v1/jobs/${priorityJob.id}`,
      headers: authHeaders(),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<SubmittedJob>().queue).toBe('priority.jobs');
  });

  it('replays identical idempotent submissions while the durable delivery is PENDING and rejects conflicts', async () => {
    const idempotencyKey = 'same-request';
    const first = await submitJob({ idempotencyKey });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers['idempotency-key']).toBe(idempotencyKey);
    const firstJob = first.json<SubmittedJob>();

    const beforeReplay = await queryOne<{ status: string }>(
      'SELECT status FROM job_deliveries WHERE job_id = $1',
      [firstJob.id]
    );
    expect(beforeReplay.status).toBe('PENDING');

    const replay = await submitJob({ idempotencyKey });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.json<SubmittedJob>().id).toBe(firstJob.id);

    const conflict = await submitJob({
      idempotencyKey,
      body: submissionBody({ payload: { value: 2 } }),
    });
    expect(conflict.statusCode, conflict.body).toBe(409);

    const counts = await queryOne<{
      jobs: number;
      keys: number;
      deliveries: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM jobs) AS jobs,
         (SELECT count(*)::int FROM idempotency_keys) AS keys,
         (SELECT count(*)::int FROM job_deliveries) AS deliveries`
    );
    expect(counts).toEqual({ jobs: 1, keys: 1, deliveries: 1 });
  });

  it('serializes simultaneous key use and permits reuse only after expiry', async () => {
    const simultaneous = await Promise.all([
      submitJob({ idempotencyKey: 'concurrent-key' }),
      submitJob({ idempotencyKey: 'concurrent-key' }),
    ]);
    expect(simultaneous.map(({ statusCode }) => statusCode).sort()).toEqual([
      200, 201,
    ]);
    const simultaneousIds = simultaneous.map(
      (response) => response.json<SubmittedJob>().id
    );
    expect(new Set(simultaneousIds).size).toBe(1);

    const initial = await submitJob({ idempotencyKey: 'expiring-key' });
    expect(initial.statusCode).toBe(201);
    const initialId = initial.json<SubmittedJob>().id;

    if (!pool) throw new Error('PostgreSQL pool not initialized');
    await pool.query(
      `UPDATE idempotency_keys
          SET created_at = clock_timestamp() - interval '2 days',
              expires_at = clock_timestamp() - interval '1 day'
        WHERE user_id = $1 AND idempotency_key = 'expiring-key'`,
      [userAId]
    );

    const reused = await submitJob({
      idempotencyKey: 'expiring-key',
      body: submissionBody({ payload: { afterExpiry: true } }),
    });
    expect(reused.statusCode, reused.body).toBe(201);
    expect(reused.json<SubmittedJob>().id).not.toBe(initialId);

    const counts = await queryOne<{
      jobs: number;
      keys: number;
      deliveries: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM jobs) AS jobs,
         (SELECT count(*)::int FROM idempotency_keys) AS keys,
         (SELECT count(*)::int FROM job_deliveries) AS deliveries`
    );
    expect(counts).toEqual({ jobs: 3, keys: 2, deliveries: 3 });
  });

  it('does not reveal cross-user jobs and reports the real tenant total', async () => {
    const ownedResponses = await Promise.all([
      submitJob({ body: submissionBody({ type: 'owned-1' }) }),
      submitJob({
        body: submissionBody({ type: 'owned-2', queue: 'priority.jobs' }),
      }),
      submitJob({ body: submissionBody({ type: 'owned-3' }) }),
    ]);
    for (const response of ownedResponses)
      expect(response.statusCode).toBe(201);
    const ownedId = ownedResponses[0].json<SubmittedJob>().id;

    const foreignCreation = await submitJob({
      apiKey: userBApiKey,
      body: submissionBody({ type: 'foreign' }),
    });
    expect(foreignCreation.statusCode).toBe(201);

    const foreignGet = await inject({
      method: 'GET',
      url: `/api/v1/jobs/${ownedId}`,
      headers: authHeaders(userBApiKey),
    });
    const foreignCancel = await inject({
      method: 'DELETE',
      url: `/api/v1/jobs/${ownedId}`,
      headers: authHeaders(userBApiKey),
    });
    expect(foreignGet.statusCode).toBe(404);
    expect(foreignCancel.statusCode).toBe(404);
    expect({
      error: foreignCancel.json<{ error: string }>().error,
      message: foreignCancel.json<{ message: string }>().message,
      statusCode: foreignCancel.json<{ statusCode: number }>().statusCode,
    }).toEqual({
      error: foreignGet.json<{ error: string }>().error,
      message: foreignGet.json<{ message: string }>().message,
      statusCode: foreignGet.json<{ statusCode: number }>().statusCode,
    });

    const page = await inject({
      method: 'GET',
      url: '/api/v1/jobs?limit=1&offset=1',
      headers: authHeaders(),
    });
    expect(page.statusCode, page.body).toBe(200);
    const pageBody = page.json<{
      data: SubmittedJob[];
      pagination: { limit: number; offset: number; total: number };
    }>();
    expect(pageBody.data).toHaveLength(1);
    expect(['default', 'priority.jobs']).toContain(pageBody.data[0]?.queue);
    expect(pageBody.pagination).toEqual({ limit: 1, offset: 1, total: 3 });

    const unchanged = await queryOne<{ status: string }>(
      'SELECT status FROM jobs WHERE id = $1',
      [ownedId]
    );
    expect(unchanged.status).toBe('QUEUED');
  });

  it('makes the Redis sliding-window decision atomically and isolates policy scopes', async () => {
    const requests = Array.from({ length: 60 }, () =>
      inject({
        method: 'POST',
        url: '/api/v1/queues/default/pause',
        headers: authHeaders(adminApiKey),
      })
    );
    const responses = await Promise.all(requests);
    const statusCounts = responses.reduce<Record<number, number>>(
      (counts, response) => ({
        ...counts,
        [response.statusCode]: (counts[response.statusCode] ?? 0) + 1,
      }),
      {}
    );
    expect(statusCounts).toEqual({ 200: 50, 429: 10 });

    if (!redis) throw new Error('Redis client not initialized');
    expect(await redis.zcard(`taskflow:rate-limit:mutation:${adminId}`)).toBe(
      50
    );

    const independentRead = await inject({
      method: 'GET',
      url: '/api/v1/jobs?limit=1',
      headers: authHeaders(adminApiKey),
    });
    expect(independentRead.statusCode, independentRead.body).toBe(200);
    expect(await redis.zcard(`taskflow:rate-limit:read:${adminId}`)).toBe(1);
  });

  it('starts as a real process and drains HTTP, Redis and PostgreSQL on SIGTERM', async () => {
    const port = await availablePort();
    const entryPoint = path.join(root, 'apps/api/dist/index.js');
    const child = spawn(process.execPath, [entryPoint], {
      cwd: root,
      env: integrationEnvironment({
        API_HOST: '127.0.0.1',
        API_PORT: String(port),
        API_SHUTDOWN_TIMEOUT_MS: '5000',
        LOG_LEVEL: 'info',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer | string): void => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const closed = new Promise<{
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signalCode) =>
        resolve({ exitCode, signalCode })
      );
    });

    try {
      await waitForHttp(`http://127.0.0.1:${port}/health/live`, child);
      expect(child.kill('SIGTERM')).toBe(true);
      const outcome = await Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`API did not exit after SIGTERM:\n${output}`)),
            10_000
          )
        ),
      ]);
      expect(outcome, output).toEqual({ exitCode: 0, signalCode: null });
      expect(output).toContain('HTTP server closed');
      expect(output).toContain('Redis connection closed');
      expect(output).toContain('Database connection closed');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed.catch(() => undefined);
      }
    }
  }, 20_000);

  it('fails mutations closed and reads open when Redis admission is unavailable', async () => {
    if (!redis) throw new Error('Redis client not initialized');
    await redis.quit();
    redis = undefined;
    docker('stop', 'redis');

    try {
      const mutation = await inject({
        method: 'POST',
        url: `/api/v1/workers/${adminId}/stop`,
        headers: authHeaders(adminApiKey),
      });
      expect(mutation.statusCode, mutation.body).toBe(503);

      const read = await inject({
        method: 'GET',
        url: '/api/v1/jobs?limit=1',
        headers: authHeaders(),
      });
      expect(read.statusCode, read.body).toBe(200);
    } finally {
      docker('up', '-d', '--wait', 'redis');
      const sharedRedis = getRedisClient();
      if (sharedRedis.status === 'end') await sharedRedis.connect();
      await sharedRedis.ping();
      redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
      redis.on('error', () => undefined);
      await redis.ping();
    }
  });
});
