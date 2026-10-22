/**
 * Shapes returned by the TaskFlow API (`/api/v1`). These mirror the server's
 * serializers: dates are ISO strings, enum values are UPPERCASE, and list
 * endpoints answer `{ data, pagination }`.
 */

export const JOB_STATUSES = [
  'CREATED',
  'QUEUED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'RETRY_SCHEDULED',
  'DEAD_LETTERED',
  'CANCEL_REQUESTED',
  'CANCELLED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export interface Job {
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

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

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
  createdAt: string;
  updatedAt: string;
}

export interface QueueStats {
  queue: string;
  timestamp: string;
  jobs: {
    queued: number;
    processing: number;
    succeeded: number;
    /** FAILED plus DEAD_LETTERED. */
    failed: number;
  };
  redis: { depth: number };
  workers: { active: number };
  performance: { avgDurationMs: number };
}

export type WorkerStatus =
  'STARTING' | 'ACTIVE' | 'STOPPING' | 'STOPPED' | 'FAILED';

export interface Worker {
  id: string;
  name: string;
  hostname: string;
  processId: number;
  queues: string[];
  status: WorkerStatus;
  concurrency: number;
  currentJobs: number;
  totalJobsProcessed: number;
  totalJobsSucceeded: number;
  totalJobsFailed: number;
  lastHeartbeat: string;
  startedAt: string;
  stoppedAt: string | null;
  version: string | null;
  metadata: Record<string, unknown> | null;
}

/** `GET /health/ready`, a public probe outside `/api/v1`. */
export interface Readiness {
  status: 'ready' | 'not_ready';
}

export interface QueueOverview {
  queue: Queue;
  stats: QueueStats;
}

/** Everything the overview page shows, measured in one polling round. */
export interface DashboardSnapshot {
  takenAt: number;
  queues: QueueOverview[];
  activeWorkers: number;
  totals: {
    queued: number;
    processing: number;
    succeeded: number;
    failed: number;
    redisDepth: number;
  };
  /** Succeeded / (succeeded + failed); null until something has finished. */
  successRate: number | null;
  /** Mean run time of succeeded jobs across queues, weighted by count. */
  avgDurationMs: number | null;
}

export interface ErrorResponse {
  error?: string;
  message?: string;
  statusCode?: number;
  timestamp?: string;
}
