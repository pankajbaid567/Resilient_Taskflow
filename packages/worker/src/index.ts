/**
 * @taskflow/worker
 *
 * Distributed worker runtime for job processing.
 *
 * Features:
 * - Job handler registry
 * - Concurrent job processing
 * - Backpressure handling
 * - Graceful shutdown
 * - Worker registration and heartbeats
 * - Job lease management
 * - Stale message recovery
 */

// Handler Registry
export { HandlerRegistry, createHandlerRegistry } from './handler-registry';

// Worker Configuration
export { getDefaultWorkerConfig, createWorkerConfig } from './worker-config';
export type { TerminalPersistedEvent, WorkerConfig } from './worker-config';

// Handlers throw this to dead-letter immediately instead of burning retries.
export { PermanentJobError } from '@taskflow/retry';

// Worker
export { Worker, createWorker } from './worker';
export type { WorkerState, WorkerStats } from './worker';

// Scheduler
export {
  Scheduler,
  SchedulerConfig,
  SchedulerStats,
  createScheduler,
} from './scheduler';

// Dispatcher (transactional outbox publisher)
export { Dispatcher, createDispatcher } from './dispatcher';
export type { DispatcherConfig, DispatcherStats } from './dispatcher';

// Cancellation
export {
  CancellationToken,
  CancellationError,
  createCancellationToken,
  checkCancellation,
} from './cancellation-token';

// Lifecycle Retention
export {
  executeFullRetention,
  type RetentionServiceOptions,
} from './retention-service';
export {
  RetentionScheduler,
  createRetentionScheduler,
  RETENTION_LOCK_KEY,
  type RetentionSchedulerConfig,
  type RetentionSchedulerStats,
  type RetentionRunOutcome,
} from './retention-scheduler';

// Prometheus endpoint for the worker process
export {
  startMetricsServer,
  type MetricsServer,
  type MetricsServerOptions,
} from './metrics-server';
