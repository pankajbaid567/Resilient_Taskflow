import { spawn, spawnSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const sourceMigrations = path.join(root, 'packages/database/migrations');
const composeFile = path.join(__dirname, 'migration-runner.compose.yml');
const composeArgs = [
  'compose',
  '-p',
  'taskflow-migration-it',
  '-f',
  composeFile,
];
const databaseUrl =
  'postgresql://taskflow_test:taskflow_test@127.0.0.1:55449/taskflow_test';
const temporaryDirectories = new Set<string>();
let pool: Pool;

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

interface ProcessResult {
  exitCode: number | null;
  output: string;
}

function runMigrations(migrationsDirectory: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@taskflow/database', 'db:migrate'],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrl,
          REDIS_URL: 'redis://127.0.0.1:1',
          JWT_SECRET: 'taskflow-migration-secret-at-least-32-characters',
          API_KEY_HASH_SALT: 'taskflow-migration-api-key-salt',
          TASKFLOW_TEST_MIGRATIONS_DIR: migrationsDirectory,
          LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let output = '';
    const collect = (chunk: Buffer | string) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, output }));
  });
}

async function createMigrationDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskflow-migrations-'));
  temporaryDirectories.add(directory);
  return directory;
}

async function copyAllMigrations(target: string): Promise<string[]> {
  const names = (await readdir(sourceMigrations))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  await Promise.all(
    names.map((name) =>
      cp(path.join(sourceMigrations, name), path.join(target, name))
    )
  );
  return names;
}

async function resetDatabase(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
}

beforeAll(async () => {
  docker('down', '--volumes', '--remove-orphans');
  docker('up', '-d', '--wait');
  pool = new Pool({ connectionString: databaseUrl, max: 2 });
}, 60_000);

beforeEach(resetDatabase);

afterAll(async () => {
  await pool?.end();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  docker('down', '--volumes', '--remove-orphans');
}, 30_000);

describe.sequential('authoritative migration runner', () => {
  it('upgrades an existing schema and records a checksum for every migration', async () => {
    const directory = await createMigrationDirectory();
    const names = (await readdir(sourceMigrations))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    expect(names.length).toBeGreaterThanOrEqual(4);

    await cp(
      path.join(sourceMigrations, names[0]!),
      path.join(directory, names[0]!)
    );
    expect((await runMigrations(directory)).exitCode).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM taskflow_schema_migrations'
        )
      ).rows[0]?.count
    ).toBe(1);

    await Promise.all(
      names
        .slice(1)
        .map((name) =>
          cp(path.join(sourceMigrations, name), path.join(directory, name))
        )
    );
    expect((await runMigrations(directory)).exitCode).toBe(0);

    const ledger = await pool.query<{
      name: string;
      checksum: string;
    }>('SELECT name, checksum FROM taskflow_schema_migrations ORDER BY name');
    expect(ledger.rows.map(({ name }) => name)).toEqual(names);
    expect(
      ledger.rows.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))
    ).toBe(true);
    expect(
      (await pool.query("SELECT to_regclass('public.job_deliveries') AS name"))
        .rows[0]?.name
    ).toBe('job_deliveries');
  }, 30_000);

  it('serializes concurrent migration starts with a PostgreSQL advisory lock', async () => {
    const directory = await createMigrationDirectory();
    const names = await copyAllMigrations(directory);

    const results = await Promise.all([
      runMigrations(directory),
      runMigrations(directory),
    ]);
    expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0]);

    const ledger = await pool.query<{
      count: number;
      distinct_count: number;
    }>(
      `SELECT count(*)::int AS count,
              count(DISTINCT name)::int AS distinct_count
         FROM taskflow_schema_migrations`
    );
    expect(ledger.rows[0]).toEqual({
      count: names.length,
      distinct_count: names.length,
    });
  }, 30_000);

  it('rejects an edited migration after its checksum has been recorded', async () => {
    const directory = await createMigrationDirectory();
    const names = await copyAllMigrations(directory);
    expect((await runMigrations(directory)).exitCode).toBe(0);

    await appendFile(
      path.join(directory, names[0]!),
      '\n-- changed after apply\n'
    );
    const replay = await runMigrations(directory);
    expect(replay.exitCode).not.toBe(0);
    expect(replay.output).toContain(
      `Checksum mismatch for applied migration ${names[0]}`
    );
  }, 30_000);

  it('rolls back both SQL and ledger state when a migration fails', async () => {
    const directory = await createMigrationDirectory();
    await copyAllMigrations(directory);
    expect((await runMigrations(directory)).exitCode).toBe(0);

    await writeFile(
      path.join(directory, '9999_intentional_failure.sql'),
      `CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);\n` +
        `SELECT missing_column FROM migration_rollback_probe;\n`
    );
    const failed = await runMigrations(directory);
    expect(failed.exitCode).not.toBe(0);

    expect(
      (
        await pool.query(
          "SELECT to_regclass('public.migration_rollback_probe') AS name"
        )
      ).rows[0]?.name
    ).toBeNull();
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count
             FROM taskflow_schema_migrations
            WHERE name = '9999_intentional_failure.sql'`
        )
      ).rows[0]?.count
    ).toBe(0);
  }, 30_000);

  it('permits the canonical lifecycle and rejects invalid persisted invariants', async () => {
    const directory = await createMigrationDirectory();
    await copyAllMigrations(directory);
    expect((await runMigrations(directory)).exitCode).toBe(0);

    const user = (
      await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash)
         VALUES ('constraints@example.test', 'test-only')
         RETURNING id`
      )
    ).rows[0]!;
    const queue = (
      await pool.query<{ id: string }>(
        `INSERT INTO queues (name, display_name)
         VALUES ('p1-constraints', 'P1 Constraints')
         RETURNING id`
      )
    ).rows[0]!;
    const worker = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (
           worker_name, hostname, process_id, concurrency, queues, status
         ) VALUES (
           'constraint-worker', 'localhost', 1, 1, ARRAY['p1-constraints'], 'ACTIVE'
         ) RETURNING id`
      )
    ).rows[0]!;
    const job = (
      await pool.query<{ id: string }>(
        `INSERT INTO jobs (
           user_id, queue_id, type, payload, status, attempts,
           max_attempts, timeout_ms, event_sequence
         ) VALUES ($1, $2, 'constraint-probe', '{}', 'CREATED', 0, 2, 1000, 1)
         RETURNING id`,
        [user.id, queue.id]
      )
    ).rows[0]!;

    await pool.query(
      `INSERT INTO job_events (
         job_id, event_type, event_sequence, from_status, to_status, user_id
       ) VALUES ($1, 'created', 1, NULL, 'CREATED', $2)`,
      [job.id, user.id]
    );
    await pool.query(
      `UPDATE jobs
          SET status = 'QUEUED', version = 2, event_sequence = 2
        WHERE id = $1`,
      [job.id]
    );
    await pool.query(
      `INSERT INTO job_events (
         job_id, event_type, event_sequence, from_status, to_status, user_id
       ) VALUES ($1, 'queued', 2, 'CREATED', 'QUEUED', $2)`,
      [job.id, user.id]
    );
    await pool.query(
      `UPDATE jobs
          SET status = 'PROCESSING', attempts = 1, worker_id = $2,
              lease_id = gen_random_uuid(), lease_expires_at = now() + interval '1 minute',
              version = 3, event_sequence = 3
        WHERE id = $1`,
      [job.id, worker.id]
    );
    await pool.query(
      `INSERT INTO job_events (
         job_id, event_type, event_sequence, from_status, to_status, worker_id, user_id
       ) VALUES ($1, 'lease_acquired', 3, 'QUEUED', 'PROCESSING', $2, $3)`,
      [job.id, worker.id, user.id]
    );
    await pool.query(
      `UPDATE jobs
          SET status = 'SUCCEEDED', result = '{"ok":true}', completed_at = now(),
              lease_id = NULL, lease_expires_at = NULL,
              version = 4, event_sequence = 4
        WHERE id = $1`,
      [job.id]
    );
    await pool.query(
      `INSERT INTO job_events (
         job_id, event_type, event_sequence, from_status, to_status, worker_id, user_id
       ) VALUES ($1, 'completed', 4, 'PROCESSING', 'SUCCEEDED', $2, $3)`,
      [job.id, worker.id, user.id]
    );

    const lifecycle = await pool.query<{
      status: string;
      attempts: number;
      sequences: number[];
    }>(
      `SELECT job.status, job.attempts,
              array_agg(event.event_sequence ORDER BY event.event_sequence)::integer[] AS sequences
         FROM jobs AS job
         JOIN job_events AS event ON event.job_id = job.id
        WHERE job.id = $1
        GROUP BY job.id`,
      [job.id]
    );
    expect(lifecycle.rows[0]).toEqual({
      status: 'SUCCEEDED',
      attempts: 1,
      sequences: [1, 2, 3, 4],
    });

    await expect(
      pool.query(`UPDATE jobs SET attempts = max_attempts + 1 WHERE id = $1`, [
        job.id,
      ])
    ).rejects.toMatchObject({ constraint: 'jobs_attempts_within_budget' });
    await expect(
      pool.query(
        `UPDATE jobs
            SET status = 'PROCESSING', lease_id = NULL, lease_expires_at = NULL
          WHERE id = $1`,
        [job.id]
      )
    ).rejects.toMatchObject({ constraint: 'jobs_lease_state_consistent' });
    await expect(
      pool.query(
        `INSERT INTO queues (name, display_name)
         VALUES ('Invalid Queue', 'Invalid Queue')`
      )
    ).rejects.toMatchObject({ constraint: 'queues_name_format' });
    await expect(
      pool.query(
        `INSERT INTO workers (
           worker_name, hostname, process_id, concurrency, queues
         ) VALUES ('invalid-worker', 'localhost', 2, 0, ARRAY['p1-constraints'])`
      )
    ).rejects.toMatchObject({ constraint: 'workers_concurrency_positive' });

    const pollingIndex = await pool.query<{ definition: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS definition
         FROM pg_index
        WHERE indexrelid = 'idx_jobs_worker_polling'::regclass`
    );
    expect(pollingIndex.rows[0]?.definition).toContain('CASE priority');

    const migrationOwnedIndexes = [
      'idx_jobs_stale_leases',
      'idx_jobs_ready_to_schedule',
      'idx_jobs_ready_to_retry',
      'idx_jobs_worker_polling',
      'idx_jobs_worker_processing',
      'idx_jobs_failed_recent',
      'idx_jobs_user_status_created',
      'idx_jobs_tags',
      'idx_workers_stale',
      'idx_workers_active_queues',
      'idx_job_attempts_job_failures',
      'idx_job_attempts_worker_recent',
      'idx_job_attempts_slow',
      'idx_dead_letter_jobs_queue_created',
      'idx_queues_active',
    ];
    const installedIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [migrationOwnedIndexes]
    );
    expect(
      new Set(installedIndexes.rows.map(({ indexname }) => indexname))
    ).toEqual(new Set(migrationOwnedIndexes));

    const advancedDefinitions = await pool.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE indexname = ANY($1::text[])`,
      [['idx_jobs_tags', 'idx_workers_active_queues']]
    );
    expect(advancedDefinitions.rows).toHaveLength(2);
    for (const index of advancedDefinitions.rows) {
      expect(index.indexdef).toContain('USING gin');
      expect(index.indexdef).toContain('WHERE');
    }
  }, 30_000);
});
