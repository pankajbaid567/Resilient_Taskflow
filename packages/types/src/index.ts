import { z } from 'zod';

/**
 * Job Status Enum
 *
 * Represents all possible states in the job lifecycle.
 * See: docs/architecture/state-machine.md
 */
export enum JobStatus {
  CREATED = 'CREATED',
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  CANCEL_REQUESTED = 'CANCEL_REQUESTED',
  CANCELLED = 'CANCELLED',
  DEAD_LETTERED = 'DEAD_LETTERED',
}

export type JobStatusValue = `${JobStatus}`;

/** Canonical ordered values for database schemas and runtime validation. */
export const JOB_STATUS_VALUES = Object.freeze(
  Object.values(JobStatus)
) as readonly [JobStatusValue, ...JobStatusValue[]];

/**
 * Job Priority Enum
 */
export enum JobPriority {
  CRITICAL = 'CRITICAL', // 10
  HIGH = 'HIGH', // 7
  NORMAL = 'NORMAL', // 5
  LOW = 'LOW', // 1
}

/**
 * Worker Status Enum
 */
export enum WorkerStatus {
  STARTING = 'STARTING',
  ACTIVE = 'ACTIVE',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
  FAILED = 'FAILED',
}

/**
 * Job Event Type
 */
export type JobEventType =
  | 'created'
  | 'queued'
  | 'started'
  | 'completed'
  | 'failed'
  | 'retried'
  | 'cancellation_requested'
  | 'cancelled'
  | 'dead_lettered'
  | 'timeout'
  | 'lease_acquired'
  | 'lease_expired'
  | 'lease_renewed'
  | 'attempt_started';

/**
 * Core Job Interface
 */
export interface Job {
  id: string;
  userId: string;
  queueId: string;
  type: string;
  payload: Record<string, unknown>;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  scheduledAt: Date;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  workerId: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  tags: string[];
  version: number;
  eventSequence: number;
}

/**
 * Job Attempt Record
 */
export interface JobAttempt {
  id: string;
  jobId: string;
  attemptNumber: number;
  workerId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  status: JobStatus;
  error: Record<string, unknown> | null;
  errorMessage: string | null;
  stackTrace: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Job Event Record
 */
export interface JobEvent {
  id: string;
  jobId: string;
  eventType: JobEventType;
  sequence: number;
  fromStatus: JobStatus | null;
  toStatus: JobStatus;
  workerId: string | null;
  userId: string | null;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
}

/**
 * Worker Record
 */
export interface Worker {
  id: string;
  workerName: string;
  hostname: string;
  processId: number;
  concurrency: number;
  queues: string[];
  status: WorkerStatus;
  currentJobCount: number;
  lastHeartbeatAt: Date;
  startedAt: Date;
  stoppedAt: Date | null;
  totalJobsProcessed: number;
  totalJobsSucceeded: number;
  totalJobsFailed: number;
  version: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Queue Configuration
 */
export interface Queue {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  priority: number;
  concurrencyLimit: number | null;
  maxRetryAttempts: number;
  defaultTimeoutMs: number;
  rateLimitPerMinute: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * User Record
 */
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: 'user' | 'admin' | 'worker';
  apiKey: string | null;
  apiKeyHash: string | null;
  rateLimitPerMinute: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Idempotency Key Record
 */
export interface IdempotencyKey {
  id: string;
  idempotencyKey: string;
  userId: string;
  jobId: string;
  requestHash: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Dead Letter Job Record
 */
export interface DeadLetterJob {
  id: string;
  originalJobId: string;
  userId: string;
  queueId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: Record<string, unknown> | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  failedAt: Date;
  requeued: boolean;
  requeuedAt: Date | null;
  requeuedJobId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Redis job message contract.
 *
 * Redis only transports this envelope. PostgreSQL remains authoritative for
 * the job payload and lifecycle state.
 */
export const REDIS_JOB_MESSAGE_VERSION = 1;
export const REDIS_JOB_MESSAGE_FIELD = 'data';

export const redisJobMessageV1Schema = z
  .object({
    schemaVersion: z.literal(REDIS_JOB_MESSAGE_VERSION),
    jobId: z.string().min(1),
    enqueuedAt: z.string().datetime(),
    // Producer-supplied delivery hint. PostgreSQL job state is authoritative
    // for retry and execution-attempt decisions.
    attempt: z.number().int().positive(),
    queue: z.string().min(1),
    type: z.string().min(1).optional(),
  })
  .strict();

export type RedisJobMessage = z.infer<typeof redisJobMessageV1Schema>;

export function parseRedisJobMessage(value: unknown): RedisJobMessage {
  return redisJobMessageV1Schema.parse(value);
}

/**
 * Kafka Job Event
 */
export interface KafkaJobEvent {
  schemaVersion: number;
  eventType: JobEventType;
  eventId: string;
  timestamp: string;
  jobId: string;
  queue: string;
  type: string;
  workerId: string | null;
  duration: number | null;
  attempts: number;
  metadata: Record<string, unknown>;
}

/**
 * Job Handler Context
 *
 * Additional context passed to job handlers.
 */
export interface JobHandlerContext {
  /**
   * Job metadata
   */
  job: {
    id: string;
    type: string;
    attempts: number;
    maxAttempts: number;
  };

  /**
   * Cancellation token
   * Handlers should check periodically and abort if cancellation is requested
   */
  cancellationToken: {
    /**
     * Check if cancellation has been requested
     */
    isCancellationRequested: boolean;

    /**
     * Throw error if cancellation has been requested
     */
    throwIfCancellationRequested(): void;

    /**
     * Register callback for cancellation
     */
    onCancellationRequested(callback: () => void): () => void;
  };
}

/**
 * Job Handler Function Type
 *
 * Handlers receive payload and context (with cancellation token).
 *
 * Example:
 * ```typescript
 * const handler: JobHandler = async (payload, ctx) => {
 *   for (const item of items) {
 *     ctx.cancellationToken.throwIfCancellationRequested();
 *     await processItem(item);
 *   }
 *   return result;
 * };
 * ```
 */
export type JobHandler<P = Record<string, unknown>, R = unknown> = (
  payload: P,
  context: JobHandlerContext
) => Promise<R>;

/**
 * Job Handler Registry
 */
export type JobHandlerRegistry = Map<string, JobHandler>;

/** Shared limits enforced by HTTP validation and PostgreSQL constraints. */
export const QUEUE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const MAX_JOB_ATTEMPTS = 10;
export const MAX_JOB_TIMEOUT_MS = 86_400_000;
export const MAX_JOB_TAGS = 32;
export const MAX_JOB_TAG_LENGTH = 64;

export const queueNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    QUEUE_NAME_PATTERN,
    'Queue names must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens'
  );

/**
 * Job Submission Request Schema
 */
export const submitJobSchema = z
  .object({
    type: z.string().trim().min(1).max(255),
    payload: z.record(z.unknown()),
    queue: queueNameSchema.optional().default('default'),
    priority: z.nativeEnum(JobPriority).optional().default(JobPriority.NORMAL),
    maxAttempts: z.number().int().min(1).max(MAX_JOB_ATTEMPTS).optional(),
    timeoutMs: z.number().int().min(1).max(MAX_JOB_TIMEOUT_MS).optional(),
    scheduledAt: z.coerce.date().optional(),
    metadata: z.record(z.unknown()).optional(),
    tags: z
      .array(z.string().trim().min(1).max(MAX_JOB_TAG_LENGTH))
      .max(MAX_JOB_TAGS)
      .optional(),
  })
  .strict();

export type SubmitJobRequest = z.infer<typeof submitJobSchema>;

/**
 * Job Response
 */
export interface JobResponse {
  id: string;
  status: JobStatus;
  type: string;
  queue: string;
  priority: JobPriority;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  scheduledAt: string;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

/**
 * Queue Statistics
 */
export interface QueueStats {
  queue: string;
  depth: number;
  processing: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number | null;
}

/**
 * Worker Statistics
 */
export interface WorkerStats {
  id: string;
  name: string;
  status: WorkerStatus;
  currentJobs: number;
  totalProcessed: number;
  successRate: number;
  lastHeartbeat: string;
}

/**
 * System Health Check
 */
export interface HealthCheck {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  checks: {
    postgres: boolean;
    redis: boolean;
    kafka: boolean;
  };
}

/**
 * API Error Response
 */
export interface ApiErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
  path?: string;
  details?: unknown;
}

/**
 * Pagination Parameters
 */
export interface PaginationParams {
  page: number;
  limit: number;
}

/**
 * Paginated Response
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}
