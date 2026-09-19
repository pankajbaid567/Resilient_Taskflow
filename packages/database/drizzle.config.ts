import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  // The custom migration runner and drizzle-kit share one authoritative path.
  out: './migrations',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL || '',
  },
  verbose: true,
  strict: true,
} satisfies Config;
