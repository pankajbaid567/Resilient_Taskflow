import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '@taskflow/logger';

import { closeConnection, sql } from './client';

const MIGRATION_LOCK_NAMESPACE = 1_410_467_908;
const MIGRATION_LOCK_ID = 1;

interface MigrationFile {
  name: string;
  path: string;
  checksum: string;
}

function getMigrationsFolder(): string {
  const testOverride = process.env.TASKFLOW_TEST_MIGRATIONS_DIR;
  if (testOverride) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        'TASKFLOW_TEST_MIGRATIONS_DIR is available only when NODE_ENV=test'
      );
    }
    return path.resolve(testOverride);
  }

  return path.resolve(__dirname, '../migrations');
}

async function readMigrationFiles(folder: string): Promise<MigrationFile[]> {
  const names = (await readdir(folder))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(folder, name);
      const contents = await readFile(filePath);
      return {
        name,
        path: filePath,
        checksum: createHash('sha256').update(contents).digest('hex'),
      };
    })
  );
}

/**
 * Apply the repository's ordered SQL migrations exactly once.
 *
 * Each file and its ledger insert share one PostgreSQL transaction. A failed
 * file is therefore absent from the ledger and safe to retry.
 */
async function runMigrations(): Promise<void> {
  const connection = await sql.reserve();
  let lockAcquired = false;

  try {
    logger.info('Starting database migrations...');

    await connection`SELECT 1`;
    await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})`;
    lockAcquired = true;

    await connection`
      CREATE TABLE IF NOT EXISTS taskflow_schema_migrations (
        name text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;
    await connection`
      ALTER TABLE taskflow_schema_migrations
      ADD COLUMN IF NOT EXISTS checksum text
    `;

    const files = await readMigrationFiles(getMigrationsFolder());
    const byName = new Map(files.map((file) => [file.name, file]));
    const applied = await connection<
      Array<{ name: string; checksum: string | null }>
    >`
      SELECT name, checksum FROM taskflow_schema_migrations ORDER BY name
    `;

    for (const migration of applied) {
      const file = byName.get(migration.name);
      if (!file) {
        throw new Error(
          `Applied migration ${migration.name} is missing from the migrations directory`
        );
      }

      if (migration.checksum === null) {
        // Repositories created by the pre-checksum runner are adopted once.
        // Subsequent edits are detected on every run.
        await connection`
          UPDATE taskflow_schema_migrations
             SET checksum = ${file.checksum}
           WHERE name = ${file.name} AND checksum IS NULL
        `;
      } else if (migration.checksum !== file.checksum) {
        throw new Error(
          `Checksum mismatch for applied migration ${migration.name}`
        );
      }

      byName.delete(migration.name);
    }

    for (const file of files) {
      if (!byName.has(file.name)) continue;

      await connection`BEGIN`;
      try {
        await connection.file(file.path, {
          cache: false,
        });
        await connection`
          INSERT INTO taskflow_schema_migrations (name, checksum)
          VALUES (${file.name}, ${file.checksum})
        `;
        await connection`COMMIT`;
      } catch (error) {
        await connection`ROLLBACK`;
        throw error;
      }
      logger.info('Database migration applied', { migration: file.name });
    }

    await connection`
      ALTER TABLE taskflow_schema_migrations
      ALTER COLUMN checksum SET NOT NULL
    `;

    logger.info('✓ Database migrations completed successfully');
  } finally {
    if (lockAcquired) {
      await connection`
        SELECT pg_advisory_unlock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})
      `.catch((error: unknown) => {
        logger.error('Failed to release migration advisory lock', { error });
      });
    }
    connection.release();
    await closeConnection();
  }
}

if (require.main === module) {
  void runMigrations().catch((error: unknown) => {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      '✗ Database migration failed'
    );
    process.exitCode = 1;
  });
}

export { runMigrations };
