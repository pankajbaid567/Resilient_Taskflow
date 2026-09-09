import type {
  Job,
  Worker,
  QueueStats,
  HealthResponse,
  ErrorResponse,
  DashboardMetrics,
} from '@/types';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

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

class APIClient {
  private baseURL: string;
  private apiKey?: string;
  private token?: string;

  constructor(baseURL: string = API_BASE_URL) {
    this.baseURL = baseURL;
  }

  setAPIKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  setToken(token: string) {
    this.token = token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const { timeout = 30000, ...fetchOptions } = options;

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseURL}${endpoint}`, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = (await response.json()) as ErrorResponse;
        throw new APIError(
          response.status,
          errorData.error || 'UnknownError',
          errorData.message || 'An unknown error occurred'
        );
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof APIError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new APIError(408, 'RequestTimeout', 'Request timed out');
        }
        throw new APIError(0, 'NetworkError', error.message);
      }

      throw new APIError(0, 'UnknownError', 'An unknown error occurred');
    }
  }

  // Job endpoints
  async submitJob(data: {
    type: string;
    payload: Record<string, any>;
    priority?: number;
    queue?: string;
    scheduledAt?: string;
    timeout?: number;
    maxAttempts?: number;
    idempotencyKey?: string;
  }): Promise<Job> {
    return this.request<Job>('/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getJob(id: string): Promise<Job> {
    return this.request<Job>(`/jobs/${id}`);
  }

  async listJobs(params?: {
    status?: string;
    queue?: string;
    type?: string;
    priority?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ jobs: Job[]; total: number; limit: number; offset: number }> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          queryParams.append(key, String(value));
        }
      });
    }

    const query = queryParams.toString();
    return this.request<{
      jobs: Job[];
      total: number;
      limit: number;
      offset: number;
    }>(`/jobs${query ? `?${query}` : ''}`);
  }

  async cancelJob(id: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/jobs/${id}`, {
      method: 'DELETE',
    });
  }

  async retryJob(id: string): Promise<Job> {
    return this.request<Job>(`/jobs/${id}/retry`, {
      method: 'POST',
    });
  }

  // Queue endpoints
  async listQueues(): Promise<QueueStats[]> {
    return this.request<QueueStats[]>('/queues');
  }

  async getQueueStats(name: string): Promise<QueueStats> {
    return this.request<QueueStats>(`/queues/${name}/stats`);
  }

  // Worker endpoints
  async listWorkers(): Promise<Worker[]> {
    return this.request<Worker[]>('/workers');
  }

  async getWorker(id: string): Promise<Worker> {
    return this.request<Worker>(`/workers/${id}`);
  }

  // Dead Letter Queue endpoints
  async listDLQ(params?: {
    limit?: number;
    offset?: number;
  }): Promise<{ jobs: Job[]; total: number; limit: number; offset: number }> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          queryParams.append(key, String(value));
        }
      });
    }

    const query = queryParams.toString();
    return this.request<{
      jobs: Job[];
      total: number;
      limit: number;
      offset: number;
    }>(`/dlq${query ? `?${query}` : ''}`);
  }

  async requeueFromDLQ(id: string): Promise<Job> {
    return this.request<Job>(`/dlq/${id}/requeue`, {
      method: 'POST',
    });
  }

  // Health and metrics
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  async getDashboardMetrics(): Promise<DashboardMetrics> {
    // This endpoint doesn't exist yet in the backend, but we'll create it
    // For now, we'll aggregate data from multiple endpoints
    const [jobs, workers, queues] = await Promise.all([
      this.listJobs({ limit: 1 }),
      this.listWorkers(),
      this.listQueues(),
    ]);

    const totalJobs = jobs.total || 0;
    const activeWorkers = workers.filter((w) => w.status === 'active').length;

    const queuedJobs = queues.reduce((sum, q) => sum + (q.queued || 0), 0);
    const processingJobs = queues.reduce(
      (sum, q) => sum + (q.processing || 0),
      0
    );
    const completedJobs = queues.reduce(
      (sum, q) => sum + (q.completed || 0),
      0
    );
    const failedJobs = queues.reduce((sum, q) => sum + (q.failed || 0), 0);

    const totalProcessed = completedJobs + failedJobs;
    const successRate =
      totalProcessed > 0 ? (completedJobs / totalProcessed) * 100 : 100;

    // Calculate average latency from queues
    const avgLatency =
      queues
        .filter((q) => q.avgProcessingTime)
        .reduce((sum, q) => sum + (q.avgProcessingTime || 0), 0) /
        (queues.filter((q) => q.avgProcessingTime).length || 1) || 0;

    return {
      activeWorkers,
      queuedJobs,
      processingJobs,
      completedJobs,
      failedJobs,
      successRate,
      avgLatency,
      p95Latency: avgLatency * 1.5, // Estimate P95 as 1.5x average
      jobsPerSecond: 0, // Would need time-series data
    };
  }
}

// Create singleton instance
const apiClient = new APIClient();

export { apiClient, APIClient, APIError };
export type { RequestOptions };
