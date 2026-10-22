import type { JobHandler } from '@taskflow/types';

/**
 * Benchmark-only handler: does no work and returns immediately, so a run
 * measures the queue (outbox, dispatch, lease, commit) rather than a handler.
 * Registered only when ENABLE_BENCHMARK_HANDLERS=true.
 */
export const noopHandler: JobHandler = () => Promise.resolve({});
