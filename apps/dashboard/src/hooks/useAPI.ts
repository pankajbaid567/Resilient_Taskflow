import { useState, useEffect, useCallback } from 'react';
import { apiClient, APIError } from '@/lib/api-client';

interface UseAPIState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface UseAPIOptions {
  skip?: boolean;
  pollingInterval?: number;
}

export function useAPI<T>(
  fetcher: () => Promise<T>,
  options: UseAPIOptions = {}
): UseAPIState<T> & { refetch: () => Promise<void> } {
  const { skip = false, pollingInterval } = options;

  const [state, setState] = useState<UseAPIState<T>>({
    data: null,
    loading: !skip,
    error: null,
  });

  const fetchData = useCallback(async () => {
    if (skip) return;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const data = await fetcher();
      setState({ data, loading: false, error: null });
    } catch (error) {
      if (error instanceof APIError) {
        setState({ data: null, loading: false, error: error.message });
      } else if (error instanceof Error) {
        setState({ data: null, loading: false, error: error.message });
      } else {
        setState({
          data: null,
          loading: false,
          error: 'An unknown error occurred',
        });
      }
    }
  }, [fetcher, skip]);

  useEffect(() => {
    fetchData();

    if (pollingInterval) {
      const interval = setInterval(fetchData, pollingInterval);
      return () => clearInterval(interval);
    }
  }, [fetchData, pollingInterval]);

  return {
    ...state,
    refetch: fetchData,
  };
}

// Specific hooks for common API calls
export function useJobs(
  params?: Parameters<typeof apiClient.listJobs>[0],
  options?: UseAPIOptions
) {
  return useAPI(() => apiClient.listJobs(params), options);
}

export function useJob(id: string, options?: UseAPIOptions) {
  return useAPI(() => apiClient.getJob(id), options);
}

export function useWorkers(options?: UseAPIOptions) {
  return useAPI(() => apiClient.listWorkers(), options);
}

export function useQueues(options?: UseAPIOptions) {
  return useAPI(() => apiClient.listQueues(), options);
}

export function useDLQ(
  params?: Parameters<typeof apiClient.listDLQ>[0],
  options?: UseAPIOptions
) {
  return useAPI(() => apiClient.listDLQ(params), options);
}

export function useHealth(options?: UseAPIOptions) {
  return useAPI(() => apiClient.health(), options);
}

export function useDashboardMetrics(options?: UseAPIOptions) {
  return useAPI(() => apiClient.getDashboardMetrics(), options);
}
