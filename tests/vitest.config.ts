import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./setup.ts'],
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
      '@taskflow/config': path.resolve(__dirname, '../packages/config/src'),
      '@taskflow/database': path.resolve(__dirname, '../packages/database/src'),
      '@taskflow/queue': path.resolve(__dirname, '../packages/queue/src'),
      '@taskflow/types': path.resolve(__dirname, '../packages/types/src'),
      '@taskflow/logger': path.resolve(__dirname, '../packages/logger/src'),
      '@taskflow/worker': path.resolve(__dirname, '../packages/worker/src'),
      '@taskflow/retry': path.resolve(__dirname, '../packages/retry/src'),
      '@taskflow/events': path.resolve(__dirname, '../packages/events/src'),
      '@taskflow/observability': path.resolve(
        __dirname,
        '../packages/observability/src'
      ),
    },
  },
});
