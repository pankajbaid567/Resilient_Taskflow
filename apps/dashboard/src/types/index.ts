export type JobStatus =
  | 'created'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'dead_letter';

export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

export interface Job {
  id: string;
  queue: string;
  type: string;
  payload: Record<string, any>;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  scheduledAt?: string;
  timeout: number;
  workerId?: string;
  error?: string;
  result?: Record<string, any>;
}

export interface Worker {
  id: string;
  status: 'active' | 'idle' | 'stopped';
  currentJob?: string;
  lastHeartbeat: string;
  processedJobs: number;
  failedJobs: number;
  startedAt: string;
  queues: string[];
}

export interface QueueStats {
  name: string;
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  byPriority: Record<string, number>;
  byStatus: Record<string, number>;
  avgProcessingTime?: number;
  successRate?: number;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  services: {
    database: { status: 'up' | 'down'; responseTime?: number };
    redis: { status: 'up' | 'down'; responseTime?: number };
    kafka?: { status: 'up' | 'down'; responseTime?: number };
  };
}

export interface DashboardMetrics {
  activeWorkers: number;
  queuedJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
  successRate: number;
  avgLatency: number;
  p95Latency: number;
  jobsPerSecond: number;
}

export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  timestamp: string;
}
