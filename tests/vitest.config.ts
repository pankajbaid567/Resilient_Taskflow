import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', 'load/**'],
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://taskflow_test:taskflow_test@127.0.0.1:5432/taskflow_test',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      JWT_SECRET:
        process.env.JWT_SECRET ??
        'taskflow-vitest-secret-at-least-32-characters',
      API_KEY_HASH_SALT:
        process.env.API_KEY_HASH_SALT ?? 'taskflow-vitest-api-key-salt',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 10000,
    isolate: true,
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.config.{ts,js}',
        '**/*.d.ts',
        '**/types/**',
        'tests/**',
      ],
      include: ['apps/**/*.ts', 'packages/**/*.ts'],
      all: true,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      // More specific alias first: the worker imports the metrics module by its
      // built path to avoid loading the OpenTelemetry SDK.
      '@taskflow/observability/dist/metrics': path.resolve(
        __dirname,
        '../packages/observability/src/metrics.ts'
      ),
      '@taskflow/config': path.resolve(__dirname, '../packages/config/src'),
      '@taskflow/database': path.resolve(__dirname, '../packages/database/src'),
      '@taskflow/queue': path.resolve(__dirname, '../packages/queue/src'),
      '@taskflow/types': path.resolve(__dirname, '../packages/types/src'),
      '@taskflow/logger': path.resolve(__dirname, '../packages/logger/src'),
      '@taskflow/worker': path.resolve(__dirname, '../packages/worker/src'),
      '@taskflow/retry': path.resolve(__dirname, '../packages/retry/src'),
      '@taskflow/observability': path.resolve(
        __dirname,
        '../packages/observability/src'
      ),
    },
  },
});
