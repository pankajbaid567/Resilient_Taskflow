import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// Global test timeout
const GLOBAL_TIMEOUT = 30000;

// Set default timeout for all tests
beforeAll(() => {
  // Setup global test environment
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
}, GLOBAL_TIMEOUT);

afterAll(async () => {
  // Cleanup global resources
  await new Promise((resolve) => setTimeout(resolve, 100));
});

// Cleanup after each test to prevent leaks
afterEach(async () => {
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
});

// Suppress console output during tests unless debugging
if (process.env.DEBUG !== 'true') {
  global.console = {
    ...console,
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    // Keep error for debugging failed tests
    error: console.error,
  };
}
