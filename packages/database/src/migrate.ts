import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '@taskflow/logger';

import { closeConnection, sql, testConnection } from './client';

const migrationsFolder = path.resolve(__dirname, '../migrations');

/**
 * Apply the repository's ordered SQL migrations exactly once.
 *
 * Each file and its ledger insert share one PostgreSQL transaction. A failed
 * file is therefore absent from the ledger and safe to retry.
 */
async function runMigrations(): Promise<void> {
  try {
    logger.info('Starting database migrations...');

    if (!(await testConnection())) {
      throw new Error('Database connection failed');
    }

    await sql`
      CREATE TABLE IF NOT EXISTS taskflow_schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `;

    const files = (await readdir(migrationsFolder))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    const applied = await sql<{ name: string }[]>`
      SELECT name FROM taskflow_schema_migrations
    `;
    const appliedNames = new Set(applied.map(({ name }) => name));

    for (const file of files) {
      if (appliedNames.has(file)) continue;

      await sql.begin(async (transaction) => {
        await transaction.file(path.join(migrationsFolder, file), {
          cache: false,
        });
        await transaction`
          INSERT INTO taskflow_schema_migrations (name) VALUES (${file})
        `;
      });
      logger.info('Database migration applied', { migration: file });
    }

    logger.info('✓ Database migrations completed successfully');
  } finally {
    await closeConnection();
  }
}

if (require.main === module) {
  void runMigrations().catch((error) => {
    logger.error('✗ Database migration failed', { error });
    process.exitCode = 1;
  });
}

export { runMigrations };
