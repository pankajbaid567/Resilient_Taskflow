# Resilient TaskFlow - Test Suite

Comprehensive testing for the distributed task queue system.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start test containers
docker compose up -d

# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage
```

## Test Categories

### Unit Tests (`tests/unit/`)

Fast, isolated tests for individual components.

```bash
pnpm test:unit
```

**Coverage**:
- State machine transitions
- Retry and backoff logic
- Queue operations and naming
- Message format validation

### Integration Tests (`tests/integration/`)

Tests component interaction with real dependencies (PostgreSQL, Redis, Kafka).

```bash
pnpm test:integration
```

**Coverage**:
- Complete job lifecycle (DB + Redis)
- Redis Streams operations
- Database transactions
- Kafka event publishing

### End-to-End Tests (`tests/e2e/`)

Full workflow tests from API submission to completion.

```bash
pnpm test:e2e
```

**Coverage**:
- Job submission → processing → completion
- Retry workflows
- Priority queue ordering
- Cancellation workflows
- Multi-queue processing

### Failure Tests (`tests/failure/`)

Tests system behavior under failure conditions.

```bash
pnpm test:failure
```

**Coverage**:
- Worker crash recovery
- Redis restart recovery
- Database connection failures
- Network partitions
- Duplicate message handling
- Poison message handling

## Test Structure

```
tests/
├── unit/                   # Unit tests
├── integration/            # Integration tests
├── e2e/                    # End-to-end tests
├── failure/                # Failure scenario tests
├── helpers/                # Test utilities
│   ├── factories.ts        # Test data factories
│   ├── test-containers.ts  # Docker container helpers
│   ├── test-db.ts         # Database test helpers
│   ├── test-redis.ts      # Redis test helpers
│   └── test-kafka.ts      # Kafka test helpers
├── setup.ts               # Global test setup
├── vitest.config.ts       # Test configuration
└── package.json
```

## Running Tests

### All Tests

```bash
# Run all tests
pnpm test

# Run in watch mode
pnpm test:watch

# Run with UI
pnpm test:ui
```

### Specific Categories

```bash
# Unit tests only
pnpm test:unit

# Integration tests only
pnpm test:integration

# E2E tests only
pnpm test:e2e

# Failure tests only
pnpm test:failure
```

### Coverage

```bash
# Generate coverage report
pnpm test:coverage

# View HTML report
open coverage/index.html
```

**Coverage Targets**:
- Lines: 70%
- Functions: 70%
- Branches: 60%
- Statements: 70%

## Prerequisites

### Docker Containers

Integration and E2E tests require Docker containers:

```bash
# Start all containers
docker compose up -d

# Check container status
docker ps

# View logs
docker compose logs -f
```

**Required Containers**:
- PostgreSQL 16 (port 5433)
- Redis 7 (port 6380)
- Redpanda (port 9093)

### Environment Variables

Copy and customize test environment:

```bash
cp .env.test.example .env.test
```

## Test Utilities

### Factories

Create test data easily:

```typescript
import { createJob, createBatchJobs } from './helpers/factories';

const job = createJob({ type: 'test-job', priority: 'HIGH' });
const jobs = createBatchJobs(10, { queue: 'high-priority' });
```

### Database Helpers

```typescript
import { withTestDatabase } from './helpers/test-db';

await withTestDatabase(async (db) => {
  // Database ready, automatically cleaned up
  const result = await db.db.query(...);
});
```

### Redis Helpers

```typescript
import { withTestRedis } from './helpers/test-redis';

await withTestRedis(async (redis) => {
  // Redis ready, flushed, automatically cleaned up
  const client = redis.getClient();
});
```

### Kafka Helpers

```typescript
import { withTestKafka } from './helpers/test-kafka';

await withTestKafka(async (kafka) => {
  // Kafka ready, topics cleaned, automatically cleaned up
  await kafka.createTopic('test-topic');
});
```

## Writing Tests

### Basic Test Structure

```typescript
import { describe, it, expect } from 'vitest';

describe('Feature', () => {
  it('should do something', () => {
    // Arrange
    const input = 'test';
    
    // Act
    const result = functionUnderTest(input);
    
    // Assert
    expect(result).toBe('expected');
  });
});
```

### Testing Async Operations

```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Testing State Transitions

```typescript
it('should transition states correctly', () => {
  const job = createJob({ status: 'QUEUED' });
  const result = transitionJob(job, 'PROCESSING');
  expect(result.status).toBe('PROCESSING');
});
```

## Debugging

### Run Single Test

```bash
pnpm vitest tests/unit/state-machine.test.ts
```

### Run Specific Test

```bash
pnpm vitest -t "should allow CREATED"
```

### Enable Debug Logging

```bash
DEBUG=true pnpm test
```

### Use Vitest UI

```bash
pnpm test:ui
```

Opens interactive test UI in browser.

## CI/CD

Tests run automatically on:
- Pull requests
- Push to main
- Manual workflow dispatch

**GitHub Actions Workflow**: `.github/workflows/test.yml`

## Best Practices

✅ **DO**:
- Write tests for new features
- Test both happy and error paths
- Use descriptive test names
- Keep tests independent
- Clean up resources

❌ **DON'T**:
- Test implementation details
- Share state between tests
- Use hardcoded delays
- Skip cleanup
- Ignore flaky tests

## Troubleshooting

### Tests Hanging

- Check for missing `await`
- Verify cleanup in `afterEach`
- Check for open connections

### Flaky Tests

- Use `waitFor` instead of delays
- Check for race conditions
- Ensure test isolation

### Container Issues

```bash
# Restart containers
docker compose restart

# View logs
docker logs taskflow-test-postgres
docker logs taskflow-test-redis
```

## Performance

**Expected Test Times**:
- Unit tests: < 10ms each
- Integration tests: 100ms - 1s each
- E2E tests: 1s - 10s each
- Full suite: < 2 minutes

## Documentation

Full documentation: [docs/testing.md](../docs/testing.md)

## Support

For issues or questions:
1. Check [docs/testing.md](../docs/testing.md)
2. Review test examples in each category
3. Check GitHub Issues
