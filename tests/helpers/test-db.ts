/**
 * Database testing utilities
 * Provides helpers for managing test database state
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '@taskflow/database/schema';

export class TestDatabase {
  private pool?: Pool;
  public db?: ReturnType<typeof drizzle>;

  async connect(connectionString: string): Promise<void> {
    this.pool = new Pool({
      connectionString,
      max: 10,
    });

    this.db = drizzle(this.pool, { schema });
  }

  async runMigrations(migrationsFolder: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }

    await migrate(this.db, { migrationsFolder });
  }

  async truncateAll(): Promise<void> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get all table names
      const { rows } = await client.query(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
        AND tablename != '__drizzle_migrations'
      `);

      // Truncate all tables
      for (const row of rows) {
        await client.query(
          `TRUNCATE TABLE "${row.tablename}" RESTART IDENTITY CASCADE`
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      this.db = undefined;
    }
  }

  async executeRaw(sql: string): Promise<void> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }

    const client = await this.pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    return this.pool;
  }
}

/**
 * Create a test database instance
 */
export function createTestDatabase(): TestDatabase {
  return new TestDatabase();
}

/**
 * Database fixture for tests
 */
export async function withTestDatabase<T>(
  fn: (db: TestDatabase) => Promise<T>
): Promise<T> {
  const testDb = createTestDatabase();

  try {
    const connectionString =
      process.env.TEST_DATABASE_URL ||
      'postgresql://testuser:testpass@localhost:5433/taskflow_test';

    await testDb.connect(connectionString);
    await testDb.truncateAll();

    return await fn(testDb);
  } finally {
    await testDb.disconnect();
  }
}
