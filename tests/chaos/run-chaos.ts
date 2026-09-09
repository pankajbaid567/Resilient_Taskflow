#!/usr/bin/env ts-node
/**
 * Chaos Test Runner
 * Execute chaos scenarios against running system
 */

import { ChaosInjector, ChaosScenarios } from './chaos-injector';

async function main() {
  const scenario = process.argv[2] || 'help';

  const injector = new ChaosInjector();

  await injector.connect({
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    databaseUrl:
      process.env.DATABASE_URL ||
      'postgresql://taskflow:taskflow@localhost:5432/taskflow',
  });

  const scenarios = new ChaosScenarios(injector);

  console.log(`\n🔥 CHAOS TESTING: ${scenario}\n`);

  try {
    switch (scenario) {
      case 'worker-crash':
        console.log('Simulating worker crash...');
        await injector.killContainer('taskflow-worker-1', {
          autoRecover: true,
          duration: 10000,
        });
        console.log('✓ Worker killed (will restart in 10s)');
        break;

      case 'postgres-restart':
        console.log('Restarting PostgreSQL...');
        await injector.restartContainer('taskflow-postgres');
        console.log('✓ PostgreSQL restarted');
        break;

      case 'redis-restart':
        console.log('Restarting Redis...');
        await injector.restartContainer('taskflow-redis');
        console.log('✓ Redis restarted');
        break;

      case 'kafka-restart':
        console.log('Restarting Kafka...');
        await injector.restartContainer('taskflow-redpanda');
        console.log('✓ Kafka restarted');
        break;

      case 'api-restart':
        console.log('Restarting API...');
        await injector.restartContainer('taskflow-api');
        console.log('✓ API restarted');
        break;

      case 'network-partition':
        console.log('Simulating network partition (pause worker for 15s)...');
        await injector.pauseContainer('taskflow-worker-1', {
          autoRecover: true,
          duration: 15000,
        });
        console.log('✓ Network partition simulated');
        break;

      case 'redis-memory-pressure':
        console.log('Filling Redis memory to 90%...');
        await injector.fillRedisMemory(90);
        console.log('✓ Redis memory pressure applied');
        break;

      case 'db-connection-exhaustion':
        console.log('Exhausting database connection pool...');
        await injector.exhaustDatabaseConnections(10);
        console.log('✓ Database connections exhausted (then released)');
        break;

      case 'slow-query':
        console.log('Injecting 10s slow query...');
        await injector.injectSlowQuery(10);
        console.log('✓ Slow query executed');
        break;

      case 'delete-redis-keys':
        console.log('Deleting 10 random Redis keys...');
        await injector.deleteRandomRedisKeys(10);
        console.log('✓ Redis keys deleted');
        break;

      case 'rolling-restarts':
        console.log('Performing rolling restarts...');
        await scenarios.rollingRestarts([
          'taskflow-worker-1',
          'taskflow-worker-2',
          'taskflow-api',
        ]);
        console.log('✓ Rolling restarts complete');
        break;

      case 'total-failure':
        console.log('Simulating total system failure...');
        await scenarios.totalSystemFailure([
          'taskflow-postgres',
          'taskflow-redis',
          'taskflow-redpanda',
          'taskflow-api',
          'taskflow-worker-1',
        ]);
        console.log('✓ Total failure simulated (auto-recovering)');
        break;

      case 'cascading-failure':
        console.log('Simulating cascading failure...');
        await scenarios.cascadingFailure([
          'taskflow-redis',
          'taskflow-api',
          'taskflow-worker-1',
          'taskflow-worker-2',
        ]);
        console.log('✓ Cascading failure simulated');
        break;

      case 'help':
      default:
        console.log('Available chaos scenarios:\n');
        console.log('  worker-crash           - Kill a worker process');
        console.log('  postgres-restart       - Restart PostgreSQL');
        console.log('  redis-restart          - Restart Redis');
        console.log('  kafka-restart          - Restart Kafka');
        console.log('  api-restart            - Restart API server');
        console.log('  network-partition      - Simulate network partition');
        console.log('  redis-memory-pressure  - Fill Redis memory');
        console.log('  db-connection-exhaustion - Exhaust DB connections');
        console.log('  slow-query             - Inject slow database query');
        console.log('  delete-redis-keys      - Delete random Redis keys');
        console.log('  rolling-restarts       - Rolling restart of services');
        console.log('  total-failure          - Kill all services');
        console.log('  cascading-failure      - Cascading service failures');
        console.log('\nUsage: pnpm chaos <scenario>');
        console.log('Example: pnpm chaos worker-crash');
        break;
    }
  } catch (error) {
    console.error('❌ Chaos test failed:', error);
    process.exit(1);
  } finally {
    await injector.disconnect();
  }

  console.log('\n✓ Chaos test complete\n');
}

main();
