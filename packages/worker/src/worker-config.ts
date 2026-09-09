import { randomUUID } from 'node:crypto';

import { env } from '@taskflow/config';
import type { ConsumedMessage } from '@taskflow/queue';
import type { JobStatus } from '@taskflow/types';

export interface TerminalPersistedEvent {
  jobId: string;
  status: JobStatus;
  message: ConsumedMessage;
}

/**
 * Runtime configuration for the canonical worker implementation.
 * Queue names and the consumer group are intentionally supplied by
 * @taskflow/queue rather than being configurable here.
 */
export interface WorkerConfig {
  workerId: string;
  workerName: string;
  queues: string[];
  concurrency: number;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  leaseRenewalIntervalMs: number;
  pollIntervalMs: number;
  batchSize: number;
  shutdownTimeoutMs: number;
  enableStaleRecovery: boolean;
  staleThresholdMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  beforeLease?: (message: ConsumedMessage) => Promise<void>;
  afterTerminalPersist?: (event: TerminalPersistedEvent) => Promise<void>;
}

export function getDefaultWorkerConfig(): WorkerConfig {
  const leaseDurationMs = env.WORKER_LEASE_DURATION_MS || 30_000;
  const concurrency = env.WORKER_CONCURRENCY || 10;

  return {
    workerId: randomUUID(),
    workerName: `worker-${process.pid}`,
    queues: env.WORKER_QUEUES?.split(',')
      .map((queue) => queue.trim())
      .filter(Boolean) || ['default'],
    concurrency,
    heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS || 10_000,
    leaseDurationMs,
    leaseRenewalIntervalMs: Math.max(1, Math.floor(leaseDurationMs / 3)),
    pollIntervalMs: 250,
    batchSize: concurrency,
    shutdownTimeoutMs: 30_000,
    enableStaleRecovery: true,
    staleThresholdMs: leaseDurationMs,
    retryBaseDelayMs: env.JOB_RETRY_BASE_DELAY_MS || 1_000,
    retryMaxDelayMs: env.JOB_RETRY_MAX_DELAY_MS || 60_000,
  };
}

export function createWorkerConfig(
  config: Partial<WorkerConfig>
): WorkerConfig {
  const defaults = getDefaultWorkerConfig();
  const leaseDurationMs = config.leaseDurationMs ?? defaults.leaseDurationMs;
  const concurrency = config.concurrency ?? defaults.concurrency;
  const merged: WorkerConfig = {
    ...defaults,
    ...config,
    concurrency,
    leaseDurationMs,
    leaseRenewalIntervalMs:
      config.leaseRenewalIntervalMs ??
      Math.max(1, Math.floor(leaseDurationMs / 3)),
    staleThresholdMs: config.staleThresholdMs ?? leaseDurationMs,
    batchSize: config.batchSize ?? concurrency,
  };

  if (!merged.workerId) throw new Error('Worker ID is required');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      merged.workerId
    )
  ) {
    throw new Error('Worker ID must be a UUID');
  }
  if (merged.queues.length === 0)
    throw new Error('At least one queue is required');
  if (!Number.isInteger(merged.concurrency) || merged.concurrency < 1) {
    throw new Error('Concurrency must be a positive integer');
  }
  if (
    !Number.isFinite(merged.heartbeatIntervalMs) ||
    merged.heartbeatIntervalMs < 1
  ) {
    throw new Error('Heartbeat interval must be positive');
  }
  if (!Number.isFinite(merged.leaseDurationMs) || merged.leaseDurationMs < 1) {
    throw new Error('Lease duration must be positive');
  }
  if (
    !Number.isFinite(merged.leaseRenewalIntervalMs) ||
    merged.leaseRenewalIntervalMs < 1
  ) {
    throw new Error('Lease renewal interval must be positive');
  }
  if (merged.leaseRenewalIntervalMs >= merged.leaseDurationMs) {
    throw new Error(
      'Lease renewal interval must be shorter than lease duration'
    );
  }
  if (!Number.isFinite(merged.pollIntervalMs) || merged.pollIntervalMs < 1) {
    throw new Error('Poll interval must be positive');
  }
  if (!Number.isInteger(merged.batchSize) || merged.batchSize < 1) {
    throw new Error('Batch size must be a positive integer');
  }
  if (
    !Number.isFinite(merged.shutdownTimeoutMs) ||
    merged.shutdownTimeoutMs < 1
  ) {
    throw new Error('Shutdown timeout must be positive');
  }
  if (
    !Number.isFinite(merged.staleThresholdMs) ||
    merged.staleThresholdMs < 1
  ) {
    throw new Error('Stale threshold must be positive');
  }
  if (
    !Number.isFinite(merged.retryBaseDelayMs) ||
    !Number.isFinite(merged.retryMaxDelayMs) ||
    merged.retryBaseDelayMs < 1 ||
    merged.retryMaxDelayMs < merged.retryBaseDelayMs
  ) {
    throw new Error('Retry delays are invalid');
  }

  return merged;
}
