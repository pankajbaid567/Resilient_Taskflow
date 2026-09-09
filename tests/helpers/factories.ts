/**
 * Test data factories
 * Provides factory functions for creating test data
 */

import { randomUUID } from 'crypto';
import type { JobStatus, JobPriority } from '@taskflow/types';

export interface JobFactory {
  id?: string;
  queue?: string;
  type?: string;
  payload?: Record<string, any>;
  priority?: JobPriority;
  status?: JobStatus;
  attempts?: number;
  maxAttempts?: number;
  timeout?: number;
  idempotencyKey?: string;
  scheduledAt?: Date;
  createdAt?: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
  workerId?: string | null;
  leaseId?: string | null;
  leaseExpiresAt?: Date | null;
  result?: Record<string, any> | null;
  error?: string | null;
  metadata?: Record<string, any>;
}

export function createJob(overrides: JobFactory = {}): JobFactory {
  return {
    id: randomUUID(),
    queue: 'default',
    type: 'test-job',
    payload: { message: 'test payload' },
    priority: 'NORMAL',
    status: 'CREATED',
    attempts: 0,
    maxAttempts: 3,
    timeout: 30000,
    idempotencyKey: null,
    scheduledAt: new Date(),
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    workerId: null,
    leaseId: null,
    leaseExpiresAt: null,
    result: null,
    error: null,
    metadata: {},
    ...overrides,
  };
}

export function createBatchJobs(
  count: number,
  overrides: JobFactory = {}
): JobFactory[] {
  return Array.from({ length: count }, () => createJob(overrides));
}

export function createJobWithPriority(
  priority: JobPriority,
  overrides: JobFactory = {}
): JobFactory {
  return createJob({ priority, ...overrides });
}

export function createScheduledJob(
  scheduledAt: Date,
  overrides: JobFactory = {}
): JobFactory {
  return createJob({ scheduledAt, ...overrides });
}

export function createFailedJob(overrides: JobFactory = {}): JobFactory {
  return createJob({
    status: 'FAILED',
    error: 'Test error',
    failedAt: new Date(),
    ...overrides,
  });
}

export function createCompletedJob(overrides: JobFactory = {}): JobFactory {
  return createJob({
    status: 'SUCCEEDED',
    result: { success: true },
    completedAt: new Date(),
    ...overrides,
  });
}

export function createProcessingJob(overrides: JobFactory = {}): JobFactory {
  const workerId = randomUUID();
  const leaseId = randomUUID();

  return createJob({
    status: 'PROCESSING',
    workerId,
    leaseId,
    leaseExpiresAt: new Date(Date.now() + 60000),
    startedAt: new Date(),
    ...overrides,
  });
}

export interface WorkerFactory {
  id?: string;
  name?: string;
  queues?: string[];
  concurrency?: number;
  status?: 'IDLE' | 'PROCESSING' | 'STOPPED';
  lastHeartbeat?: Date;
  createdAt?: Date;
  metadata?: Record<string, any>;
}

export function createWorker(overrides: WorkerFactory = {}): WorkerFactory {
  return {
    id: randomUUID(),
    name: 'test-worker',
    queues: ['default'],
    concurrency: 10,
    status: 'IDLE',
    lastHeartbeat: new Date(),
    createdAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

export interface QueueFactory {
  name?: string;
  priority?: JobPriority;
  concurrency?: number;
  createdAt?: Date;
  metadata?: Record<string, any>;
}

export function createQueue(overrides: QueueFactory = {}): QueueFactory {
  return {
    name: 'default',
    priority: 'NORMAL',
    concurrency: 10,
    createdAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

export interface JobAttemptFactory {
  id?: string;
  jobId?: string;
  attempt?: number;
  workerId?: string;
  startedAt?: Date;
  completedAt?: Date | null;
  error?: string | null;
  metadata?: Record<string, any>;
}

export function createJobAttempt(
  overrides: JobAttemptFactory = {}
): JobAttemptFactory {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    attempt: 1,
    workerId: randomUUID(),
    startedAt: new Date(),
    completedAt: null,
    error: null,
    metadata: {},
    ...overrides,
  };
}

/**
 * Sleep utility for tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = options.timeout || 5000;
  const interval = options.interval || 100;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Retry an operation with exponential backoff
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: { maxAttempts?: number; baseDelay?: number } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelay = options.baseDelay || 100;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}
