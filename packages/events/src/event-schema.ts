import { JobPriority, JobStatus } from '@taskflow/types';

/**
 * Job Event Types
 * 
 * Lifecycle events emitted when job state changes.
 */
export enum JobEventType {
  CREATED = 'job.created',
  QUEUED = 'job.queued',
  STARTED = 'job.started',
  COMPLETED = 'job.completed',
  FAILED = 'job.failed',
  RETRIED = 'job.retried',
  CANCELLED = 'job.cancelled',
  DEAD_LETTERED = 'job.dead_lettered',
  TIMEOUT = 'job.timeout',
}

/**
 * Base Job Event
 * 
 * Common fields for all job events.
 */
export interface BaseJobEvent {
  /**
   * Event type
   */
  eventType: JobEventType;

  /**
   * Event timestamp (ISO 8601)
   */
  timestamp: string;

  /**
   * Job ID
   */
  jobId: string;

  /**
   * User ID (job owner)
   */
  userId: string;

  /**
   * Queue ID
   */
  queueId: string;

  /**
   * Job type
   */
  jobType: string;

  /**
   * Job priority
   */
  priority: JobPriority;

  /**
   * Correlation ID for tracing
   */
  correlationId?: string;
}

/**
 * Job Created Event
 * 
 * Emitted when a job is first created.
 */
export interface JobCreatedEvent extends BaseJobEvent {
  eventType: JobEventType.CREATED;

  /**
   * Scheduled execution time
   */
  scheduledAt: string;

  /**
   * Maximum retry attempts
   */
  maxAttempts: number;

  /**
   * Job timeout (milliseconds)
   */
  timeoutMs: number;

  /**
   * Job tags
   */
  tags?: string[];
}

/**
 * Job Queued Event
 * 
 * Emitted when a job is enqueued to Redis Streams.
 */
export interface JobQueuedEvent extends BaseJobEvent {
  eventType: JobEventType.QUEUED;

  /**
   * Queue name
   */
  queue: string;
}

/**
 * Job Started Event
 * 
 * Emitted when a worker starts processing a job.
 */
export interface JobStartedEvent extends BaseJobEvent {
  eventType: JobEventType.STARTED;

  /**
   * Worker ID
   */
  workerId: string;

  /**
   * Attempt number (1-indexed)
   */
  attempt: number;

  /**
   * Lease ID
   */
  leaseId: string;

  /**
   * Lease expiration time
   */
  leaseExpiresAt: string;
}

/**
 * Job Completed Event
 * 
 * Emitted when a job completes successfully.
 */
export interface JobCompletedEvent extends BaseJobEvent {
  eventType: JobEventType.COMPLETED;

  /**
   * Worker ID
   */
  workerId: string;

  /**
   * Attempt number
   */
  attempt: number;

  /**
   * Processing duration (milliseconds)
   */
  durationMs: number;

  /**
   * Result summary (not full result)
   */
  resultSummary?: string;
}

/**
 * Job Failed Event
 * 
 * Emitted when a job fails.
 */
export interface JobFailedEvent extends BaseJobEvent {
  eventType: JobEventType.FAILED;

  /**
   * Worker ID
   */
  workerId: string;

  /**
   * Attempt number
   */
  attempt: number;

  /**
   * Error message
   */
  error: string;

  /**
   * Error type/code
   */
  errorType?: string;

  /**
   * Processing duration (milliseconds)
   */
  durationMs: number;

  /**
   * Will retry?
   */
  willRetry: boolean;
}

/**
 * Job Retried Event
 * 
 * Emitted when a job is scheduled for retry.
 */
export interface JobRetriedEvent extends BaseJobEvent {
  eventType: JobEventType.RETRIED;

  /**
   * Attempt number that failed
   */
  previousAttempt: number;

  /**
   * Next attempt number
   */
  nextAttempt: number;

  /**
   * Retry delay (milliseconds)
   */
  retryDelayMs: number;

  /**
   * Scheduled retry time
   */
  retryAt: string;

  /**
   * Previous error
   */
  previousError: string;
}

/**
 * Job Cancelled Event
 * 
 * Emitted when a job is cancelled.
 */
export interface JobCancelledEvent extends BaseJobEvent {
  eventType: JobEventType.CANCELLED;

  /**
   * Cancellation reason
   */
  reason?: string;

  /**
   * Was the job running when cancelled?
   */
  wasRunning: boolean;

  /**
   * Worker ID (if running)
   */
  workerId?: string;
}

/**
 * Job Dead Lettered Event
 * 
 * Emitted when a job is moved to dead letter queue.
 */
export interface JobDeadLetteredEvent extends BaseJobEvent {
  eventType: JobEventType.DEAD_LETTERED;

  /**
   * Total attempts made
   */
  attempts: number;

  /**
   * Final error message
   */
  finalError: string;

  /**
   * Reason for dead lettering
   */
  reason: string;
}

/**
 * Job Timeout Event
 * 
 * Emitted when a job times out during execution.
 */
export interface JobTimeoutEvent extends BaseJobEvent {
  eventType: JobEventType.TIMEOUT;

  /**
   * Worker ID
   */
  workerId: string;

  /**
   * Attempt number
   */
  attempt: number;

  /**
   * Timeout duration (milliseconds)
   */
  timeoutMs: number;

  /**
   * Actual duration before timeout (milliseconds)
   */
  durationMs: number;
}

/**
 * Union type of all job events
 */
export type JobEvent =
  | JobCreatedEvent
  | JobQueuedEvent
  | JobStartedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | JobRetriedEvent
  | JobCancelledEvent
  | JobDeadLetteredEvent
  | JobTimeoutEvent;

/**
 * Event envelope for Kafka messages
 */
export interface EventEnvelope<T = JobEvent> {
  /**
   * Event ID (unique)
   */
  eventId: string;

  /**
   * Event version (schema version)
   */
  version: string;

  /**
   * Event payload
   */
  event: T;

  /**
   * Metadata
   */
  metadata?: {
    /**
     * Source service
     */
    source?: string;

    /**
     * Environment
     */
    environment?: string;

    /**
     * Additional context
     */
    [key: string]: unknown;
  };
}

/**
 * Topic names for job events
 */
export const KAFKA_TOPICS = {
  JOB_EVENTS: 'taskflow.job.events',
  JOB_LIFECYCLE: 'taskflow.job.lifecycle',
  DEAD_LETTER: 'taskflow.dead-letter',
} as const;

/**
 * Kafka message headers
 */
export interface KafkaMessageHeaders {
  /**
   * Event type
   */
  eventType: string;

  /**
   * Job ID
   */
  jobId: string;

  /**
   * Correlation ID
   */
  correlationId?: string;

  /**
   * User ID
   */
  userId?: string;
}
