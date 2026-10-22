import { isHeartbeatFresh } from '@/lib/utils';
import type {
  DashboardSnapshot,
  ErrorResponse,
  Job,
  JobPriority,
  JobStatus,
  Page,
  Queue,
  QueueOverview,
  QueueStats,
  Readiness,
  Worker,
  WorkerStatus,
} from '@/types';

/**
 * Base URL of the versioned API. In development this is the Vite proxy path;
 * set VITE_API_URL at build time to point somewhere else.
 */
const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? '/api/v1';

/** Probe endpoints live beside `/api/v1`, not under it. */
const SERVICE_ROOT_URL = API_BASE_URL.replace(/\/api\/v1\/?$/, '');

const DEFAULT_TIMEOUT_MS = 30_000;

class APIError extends Error {
  constructor(
    public statusCode: number,
    public error: string,
    message: string
  ) {
    super(message);
    this.name = 'APIError';
  }
}

interface RequestOptions extends RequestInit {
  timeout?: number;
}

export interface ListJobsParams {
  status?: JobStatus;
  limit?: number;
  offset?: number;
}

export interface SubmitJobInput {
  type: string;
  payload: Record<string, unknown>;
  queue?: string;
  priority?: JobPriority;
  maxAttempts?: number;
  timeoutMs?: number;
  scheduledAt?: string;
  idempotencyKey?: string;
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

class APIClient {
  private apiKey?: string;
  private onUnauthorized?: () => void;

  constructor(private readonly baseURL: string = API_BASE_URL) {}

  setAPIKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
  }

  /** Called once whenever the server rejects the current credentials. */
  setUnauthorizedHandler(handler: (() => void) | undefined): void {
    this.onUnauthorized = handler;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestOptions
  ): Promise<Response> {
    const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetch(url, { ...fetchOptions, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new APIError(408, 'RequestTimeout', 'Request timed out');
      }
      throw new APIError(
        0,
        'NetworkError',
        error instanceof Error ? error.message : 'Network request failed'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.apiKey) headers.set('X-API-Key', this.apiKey);

    const response = await this.fetchWithTimeout(`${this.baseURL}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      // Error bodies are JSON from the API but can be anything from a proxy.
      const body = (await response.json().catch(() => ({}))) as ErrorResponse;
      if (response.status === 401) this.onUnauthorized?.();
      throw new APIError(
        response.status,
        body.error ?? 'UnknownError',
        body.message ?? (response.statusText || 'Request failed')
      );
    }

    return (await response.json()) as T;
  }

  // ---- Jobs ----

  listJobs(params: ListJobsParams = {}): Promise<Page<Job>> {
    return this.request(`/jobs${toQuery({ ...params })}`);
  }

  getJob(id: string): Promise<Job> {
    return this.request(`/jobs/${encodeURIComponent(id)}`);
  }

  submitJob(input: SubmitJobInput): Promise<Job> {
    const { idempotencyKey, ...body } = input;
    return this.request('/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    });
  }

  /** Immediate for waiting jobs; a request the worker honours when running. */
  cancelJob(id: string): Promise<Job> {
    return this.request(`/jobs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /** Creates a replacement for a dead-lettered job and returns it. */
  retryJob(id: string): Promise<Job> {
    return this.request(`/jobs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
  }

  // ---- Queues ----

  listQueues(): Promise<Page<Queue>> {
    return this.request(`/queues${toQuery({ limit: 100 })}`);
  }

  getQueueStats(name: string): Promise<QueueStats> {
    return this.request(`/queues/${encodeURIComponent(name)}/stats`);
  }

  /** Admin only. */
  pauseQueue(name: string): Promise<Queue> {
    return this.request(`/queues/${encodeURIComponent(name)}/pause`, {
      method: 'POST',
    });
  }

  /** Admin only. */
  resumeQueue(name: string): Promise<Queue> {
    return this.request(`/queues/${encodeURIComponent(name)}/resume`, {
      method: 'POST',
    });
  }

  // ---- Workers ----

  listWorkers(
    params: { status?: WorkerStatus; limit?: number; offset?: number } = {}
  ): Promise<Page<Worker>> {
    return this.request(`/workers${toQuery({ limit: 100, ...params })}`);
  }

  /** Admin only. Asks the worker process to shut down gracefully. */
  stopWorker(id: string): Promise<Worker> {
    return this.request(`/workers/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
  }

  // ---- Health ----

  /**
   * Readiness is public and reports 503 with a JSON body when a dependency is
   * down; that is a normal answer here, not an error.
   */
  async readiness(): Promise<Readiness> {
    const response = await this.fetchWithTimeout(
      `${SERVICE_ROOT_URL}/health/ready`,
      { timeout: 5_000 }
    );
    const body = (await response.json().catch(() => null)) as {
      status?: string;
    } | null;
    return { status: body?.status === 'ready' ? 'ready' : 'not_ready' };
  }

  // ---- Aggregates ----

  async getQueueOverview(): Promise<QueueOverview[]> {
    const queues = await this.listQueues();
    return Promise.all(
      queues.data.map(async (queue) => ({
        queue,
        stats: await this.getQueueStats(queue.name),
      }))
    );
  }

  /**
   * Everything on the overview page, assembled from real endpoints. Nothing
   * here is estimated: values the API cannot provide (percentile latency,
   * throughput) are simply not reported.
   */
  async getDashboardSnapshot(): Promise<DashboardSnapshot> {
    const [queues, activeWorkers] = await Promise.all([
      this.getQueueOverview(),
      this.listWorkers({ status: 'ACTIVE' }),
    ]);

    const totals = queues.reduce(
      (sum, { stats }) => ({
        queued: sum.queued + stats.jobs.queued,
        processing: sum.processing + stats.jobs.processing,
        succeeded: sum.succeeded + stats.jobs.succeeded,
        failed: sum.failed + stats.jobs.failed,
        redisDepth: sum.redisDepth + stats.redis.depth,
      }),
      { queued: 0, processing: 0, succeeded: 0, failed: 0, redisDepth: 0 }
    );

    const finished = totals.succeeded + totals.failed;

    const timed = queues.filter(
      ({ stats }) =>
        stats.jobs.succeeded > 0 &&
        Number.isFinite(stats.performance.avgDurationMs)
    );
    const timedJobs = timed.reduce(
      (n, { stats }) => n + stats.jobs.succeeded,
      0
    );
    const avgDurationMs =
      timedJobs > 0
        ? timed.reduce(
            (sum, { stats }) =>
              sum + stats.performance.avgDurationMs * stats.jobs.succeeded,
            0
          ) / timedJobs
        : null;

    return {
      takenAt: Date.now(),
      queues,
      // A crashed worker stays ACTIVE in the database, so count only those
      // that are actually heartbeating.
      activeWorkers: activeWorkers.data.filter((worker) =>
        isHeartbeatFresh(worker.lastHeartbeat)
      ).length,
      totals,
      successRate: finished > 0 ? (totals.succeeded / finished) * 100 : null,
      avgDurationMs,
    };
  }
}

// Singleton shared by the hooks and the auth provider.
const apiClient = new APIClient();

export { apiClient, APIClient, APIError };
export type { RequestOptions };
