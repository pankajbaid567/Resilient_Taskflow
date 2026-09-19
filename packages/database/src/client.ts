import { databaseConfig } from '@taskflow/config';
import { logger } from '@taskflow/logger';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

/**
 * PostgreSQL Connection Pool
 */
const connectionString = databaseConfig.url;

function connectionTimeoutSeconds(): number {
  const configured =
    process.env.NODE_ENV === 'test'
      ? process.env.TASKFLOW_TEST_DATABASE_CONNECT_TIMEOUT_SECONDS
      : undefined;
  if (configured === undefined) return 10;

  const timeout = Number(configured);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10) {
    throw new Error(
      'TASKFLOW_TEST_DATABASE_CONNECT_TIMEOUT_SECONDS must be an integer from 1 to 10'
    );
  }
  return timeout;
}

// Drizzle serializes JSON/JSONB values before passing them to postgres.js.
// postgres.js otherwise serializes that string a second time once PostgreSQL
// resolves the parameter as JSONB, storing a JSON string instead of the object.
const drizzleJsonType = {
  to: 114,
  from: [114, 3802],
  serialize: (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value),
  parse: (value: string): unknown => JSON.parse(value),
};

// Create postgres connection
const queryClient = postgres(connectionString, {
  max: databaseConfig.pool.max,
  idle_timeout: 20,
  connect_timeout: connectionTimeoutSeconds(),
  prepare: false, // Disable prepared statements for better compatibility
  types: { json: drizzleJsonType },
  onnotice: () => {}, // Suppress notices
});

/**
 * Drizzle ORM Database Instance
 */
export const db = drizzle(queryClient, { schema, logger: false });

/**
 * Raw SQL client for complex queries
 */
export const sql = queryClient;

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    logger.info('✓ Database connection successful');
    return true;
  } catch (error) {
    logger.error('✗ Database connection failed', { error });
    return false;
  }
}

/**
 * Close database connection
 */
export async function closeConnection(): Promise<void> {
  await sql.end();
  logger.info('Database connection closed');
}

/**
 * Transaction helper
 */
export async function transaction<T>(
  callback: (tx: typeof db) => Promise<T>
): Promise<T> {
  return db.transaction(callback);
}

/**
 * Initialize database connection
 * Tests connection and logs status
 */
export async function initDatabase(): Promise<void> {
  const isConnected = await testConnection();
  if (!isConnected) {
    throw new Error('Failed to connect to database');
  }
}
