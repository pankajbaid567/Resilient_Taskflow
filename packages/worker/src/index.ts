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

// Cancellation
export {
  CancellationToken,
  CancellationError,
  createCancellationToken,
  checkCancellation,
  createTimeoutCancellationToken,
  combineCancellationTokens,
} from './cancellation-token';
