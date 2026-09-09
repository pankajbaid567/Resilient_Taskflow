# Testing Guide

Comprehensive testing documentation for Resilient TaskFlow.

## Table of Contents

- [Overview](#overview)
- [Test Structure](#test-structure)
- [Running Tests](#running-tests)
- [Test Categories](#test-categories)
- [Testing Utilities](#testing-utilities)
- [Writing Tests](#writing-tests)
- [Coverage](#coverage)
- [CI/CD Integration](#cicd-integration)

## Overview

Resilient TaskFlow implements a comprehensive testing strategy across multiple layers:

1. **Unit Tests** - Individual component behavior
2. **Integration Tests** - Component interaction and data flow
3. **End-to-End Tests** - Complete workflow scenarios
4. **Failure Tests** - Crash recovery and failure scenarios

### Testing Philosophy

- **Test behavior, not implementation** - Focus on what the code does, not how
- **Test failure scenarios extensively** - Distributed systems fail in complex ways
- **Use real dependencies where possible** - Docker containers for Redis, PostgreSQL, Kafka
- **Maintain test isolation** - Each test should be independent
- **Fast feedback** - Unit tests run in milliseconds, integration tests in seconds

## Test Structure

```
tests/
├── unit/                      # Unit tests
│   ├── state-machine.test.ts
│   ├── retry-backoff.test.ts
│   └── queue-operations.test.ts
├── integration/               # Integration tests
│   ├── job-lifecycle.test.ts
│   └── redis-queue.test.ts
├── e2e/                       # End-to-end tests
│   └── complete-workflow.test.ts
├── failure/                   # Failure scenario tests
│   └── crash-recovery.test.ts
├── helpers/                   # Test utilities
│   ├── factories.ts
│   ├── test-containers.ts
│   ├── test-db.ts
│   ├── test-redis.ts
│   └── test-kafka.ts
├── setup.ts                   # Global test setup
├── vitest.config.ts           # Vitest configuration
└── package.json
```

## Running Tests

### All Tests

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run in watch mode
pnpm test:watch

# Run with UI
pnpm test:ui
```

### Specific Test Suites

```bash
# Unit tests only
pnpm test:unit

# Integration tests only
pnpm test:integration

# End-to-end tests only
pnpm test:e2e

# Failure tests only
pnpm test:failure
```

### Individual Test Files

```bash
# Run specific test file
pnpm vitest tests/unit/state-machine.test.ts

# Run specific test pattern
pnpm vitest --testNamePattern="should retry"
```

## Test Categories

### Unit Tests

**Purpose**: Test individual functions and classes in isolation.

**Characteristics**:
- Fast (< 10ms per test)
- No external dependencies
- Pure logic testing
- Mocked dependencies

**Example Tests**:
- State machine transitions
- Retry backoff calculations
- Message format validation
- Queue naming conventions

**Running Unit Tests**:

```bash
pnpm test:unit
```

### Integration Tests

**Purpose**: Test interaction between components with real dependencies.

**Characteristics**:
- Medium speed (100ms - 1s per test)
- Use Docker containers (Redis, PostgreSQL, Kafka)
- Test data flow between components
- Verify side effects

**Example Tests**:
- Job creation → Database → Redis Stream
- Worker consuming → Processing → Acknowledgement
- Kafka event publishing and consumption
- Database transactions and rollbacks

**Prerequisites**:

```bash
# Start test containers
docker compose up -d postgres redis redpanda
```

**Running Integration Tests**:

```bash
pnpm test:integration
```

### End-to-End Tests

**Purpose**: Test complete workflows from API to completion.

**Characteristics**:
- Slower (1s - 10s per test)
- Full system stack
- Realistic scenarios
- Multiple state transitions

**Example Tests**:
- Complete job lifecycle: Submit → Queue → Process → Complete
- Retry workflow with eventual success
- Priority queue ordering
- Cancellation workflows

**Running E2E Tests**:

```bash
pnpm test:e2e
```

### Failure Tests

**Purpose**: Verify system behavior under failure conditions.

**Characteristics**:
- Simulate crashes and failures
- Test recovery mechanisms
- Verify data consistency
- Test edge cases

**Example Tests**:
- Worker crash recovery
- Redis restart recovery
- Database connection failure
- Network partition handling
- Duplicate message handling
- Poison message handling

**Running Failure Tests**:

```bash
pnpm test:failure
```

## Testing Utilities

### Test Factories

Located in `tests/helpers/factories.ts`.

**Job Factory**:

```typescript
import { createJob, createBatchJobs } from '../helpers/factories';

// Create single job
const job = createJob({
  type: 'test-job',
  queue: 'default',
  priority: 'HIGH',
});

// Create batch of jobs
const jobs = createBatchJobs(10, { queue: 'high-priority' });

// Create specialized jobs
const failedJob = createFailedJob();
const completedJob = createCompletedJob();
const processingJob = createProcessingJob();
```

**Utility Functions**:

```typescript
import { sleep, waitFor, retry } from '../helpers/factories';

// Sleep for duration
await sleep(1000);

// Wait for condition
await waitFor(() => job.status === 'COMPLETED', {
  timeout: 5000,
  interval: 100,
});

// Retry operation
const result = await retry(
  async () => await database.connect(),
  { maxAttempts: 3, baseDelay: 100 }
);
```

### Test Containers

Located in `tests/helpers/test-containers.ts`.

**Usage**:

```typescript
import { TestContainers } from '../helpers/test-containers';

const containers = new TestContainers();

// Start PostgreSQL
await containers.startPostgres(5433);

// Start Redis
await containers.startRedis(6380);

// Start Kafka
await containers.startKafka(9093);

// Cleanup
await containers.stopAll();
await containers.removeAll();
```

### Test Database

Located in `tests/helpers/test-db.ts`.

**Usage**:

```typescript
import { withTestDatabase } from '../helpers/test-db';

await withTestDatabase(async (db) => {
  // Database is connected and ready
  const result = await db.db.query(...);
  
  // Automatically cleaned up after test
});
```

### Test Redis

Located in `tests/helpers/test-redis.ts`.

**Usage**:

```typescript
import { withTestRedis } from '../helpers/test-redis';

await withTestRedis(async (redis) => {
  // Redis is connected and flushed
  const client = redis.getClient();
  await client.xadd('stream', '*', 'data', 'value');
  
  // Automatically cleaned up after test
});
```

### Test Kafka

Located in `tests/helpers/test-kafka.ts`.

**Usage**:

```typescript
import { withTestKafka } from '../helpers/test-kafka';

await withTestKafka(async (kafka) => {
  // Kafka is connected and topics cleaned
  await kafka.createTopic('test-topic');
  await kafka.produceMessage('test-topic', { value: 'test' });
  
  // Automatically cleaned up after test
});
```

## Writing Tests

### Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Feature Name', () => {
  beforeEach(() => {
    // Setup before each test
  });

  afterEach(() => {
    // Cleanup after each test
  });

  describe('Specific Behavior', () => {
    it('should do something expected', () => {
      // Arrange
      const input = 'test';
      
      // Act
      const result = functionUnderTest(input);
      
      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

### Testing Async Code

```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Testing Errors

```typescript
it('should throw on invalid input', () => {
  expect(() => {
    functionThatThrows();
  }).toThrow('Expected error message');
});

it('should reject promise on error', async () => {
  await expect(asyncFunctionThatRejects()).rejects.toThrow();
});
```

### Testing State Transitions

```typescript
it('should transition from QUEUED to PROCESSING', () => {
  const job = createJob({ status: 'QUEUED' });
  
  const result = transitionJob(job, 'PROCESSING');
  
  expect(result.status).toBe('PROCESSING');
  expect(result.startedAt).toBeInstanceOf(Date);
});
```

### Testing Race Conditions

```typescript
it('should handle concurrent state updates', async () => {
  const job = createJob({ status: 'QUEUED' });
  
  // Simulate concurrent updates
  const promises = [
    updateJobStatus(job.id, 'PROCESSING'),
    updateJobStatus(job.id, 'CANCELLED'),
  ];
  
  const results = await Promise.allSettled(promises);
  
  // One should succeed, one should fail
  const succeeded = results.filter(r => r.status === 'fulfilled');
  expect(succeeded.length).toBe(1);
});
```

### Testing Idempotency

```typescript
it('should be idempotent', async () => {
  const key = 'idempotency-key-123';
  
  const result1 = await submitJob({ idempotencyKey: key });
  const result2 = await submitJob({ idempotencyKey: key });
  
  expect(result1.id).toBe(result2.id);
});
```

### Testing Retry Logic

```typescript
it('should retry with exponential backoff', () => {
  const attempts = [1, 2, 3, 4];
  const delays = attempts.map(a => 
    calculateBackoff({ attempt: a, baseDelay: 1000, factor: 2 })
  );
  
  // 1000, 2000, 4000, 8000
  expect(delays[0]).toBe(1000);
  expect(delays[1]).toBe(2000);
  expect(delays[2]).toBe(4000);
  expect(delays[3]).toBe(8000);
});
```

## Coverage

### Coverage Targets

- **Lines**: 70%
- **Functions**: 70%
- **Branches**: 60%
- **Statements**: 70%

### Generating Coverage Reports

```bash
# Generate coverage report
pnpm test:coverage

# View HTML report
open coverage/index.html
```

### Coverage Configuration

Coverage is configured in `tests/vitest.config.ts`:

```typescript
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
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 60,
    statements: 70,
  },
}
```

## CI/CD Integration

### GitHub Actions

Tests run automatically on:
- Pull requests
- Push to main
- Manual workflow dispatch

### Test Workflow

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: testpass
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
      
      redis:
        image: redis:7-alpine
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
      
      redpanda:
        image: redpandadata/redpanda:latest
    
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:coverage
      
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
```

## Best Practices

### DO

✅ Write tests before or alongside code  
✅ Test edge cases and failure scenarios  
✅ Use descriptive test names  
✅ Keep tests independent and isolated  
✅ Use real dependencies for integration tests  
✅ Clean up resources after tests  
✅ Test both happy paths and error paths  
✅ Use factories for test data  
✅ Mock external services only when necessary  

### DON'T

❌ Test implementation details  
❌ Write tests that depend on execution order  
❌ Use hardcoded delays (`setTimeout`) for synchronization  
❌ Share state between tests  
❌ Test the framework (e.g., testing that Fastify works)  
❌ Ignore flaky tests  
❌ Skip cleanup  
❌ Test multiple concerns in one test  

## Debugging Tests

### Run Single Test

```bash
pnpm vitest tests/unit/state-machine.test.ts -t "should allow CREATED"
```

### Enable Debug Logging

```bash
DEBUG=true pnpm test
```

### Use Vitest UI

```bash
pnpm test:ui
```

### VSCode Debugging

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Tests",
  "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/vitest",
  "args": ["--run", "--threads", "false"],
  "console": "integratedTerminal"
}
```

## Troubleshooting

### Tests Hanging

- Check for missing `await` on async operations
- Verify cleanup in `afterEach`/`afterAll`
- Check for open connections or timers

### Flaky Tests

- Use `waitFor` instead of fixed delays
- Check for race conditions
- Ensure test isolation
- Verify cleanup between tests

### Container Issues

```bash
# Check container status
docker ps -a

# View container logs
docker logs taskflow-test-postgres
docker logs taskflow-test-redis
docker logs taskflow-test-redpanda

# Restart containers
docker restart taskflow-test-postgres
```

### Database Connection Issues

```bash
# Verify database is accessible
psql postgresql://testuser:testpass@localhost:5433/taskflow_test

# Check for lingering connections
docker exec taskflow-test-postgres psql -U testuser -d taskflow_test -c "SELECT count(*) FROM pg_stat_activity;"
```

## Performance

### Test Execution Times

- **Unit tests**: < 10ms each
- **Integration tests**: 100ms - 1s each
- **E2E tests**: 1s - 10s each
- **Failure tests**: 1s - 5s each

### Optimization Tips

1. Use `vi test.concurrent` for parallel execution where safe
2. Share expensive setup with `beforeAll` when appropriate
3. Use test factories instead of real database inserts where possible
4. Mock external services for unit tests
5. Run unit tests first, then integration tests

## Related Documentation

- [Architecture Overview](./architecture-overview.md)
- [Failure Model](./failure-model.md)
- [State Machine](./state-machine.md)
- [Contributing Guide](../README.md#contributing)
