import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, type ListJobsParams } from '@/lib/api-client';
import type { WorkerStatus } from '@/types';

export interface UseAPIState<T> {
  data: T | null;
  /** True until the first result for the current `key` arrives. */
  loading: boolean;
  /** True while a background refresh is in flight. */
  refreshing: boolean;
  error: string | null;
}

export interface UseAPIOptions {
  skip?: boolean;
  /** Milliseconds between the END of one fetch and the start of the next. */
  pollingInterval?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'An unknown error occurred';
}

/**
 * Fetch `fetcher()` whenever `key` changes, optionally polling.
 *
 * `key` must identify the fetcher's inputs (for example
 * `JSON.stringify(params)`). The fetcher itself is read through a ref, so
 * passing a new inline arrow every render is fine and does NOT refetch;
 * only a change of `key`, `skip` or `pollingInterval` does.
 *
 * Guarantees:
 * - one request in flight per hook: the next poll is scheduled only after the
 *   previous one settles;
 * - a response for an outdated `key` (or after unmount) is discarded;
 * - polling pauses while the tab is hidden and resumes with an immediate
 *   refresh when it becomes visible;
 * - a failed refresh keeps the last good `data` and reports `error` beside it.
 */
export function useAPI<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: UseAPIOptions = {}
): UseAPIState<T> & { refetch: () => Promise<void> } {
  const { skip = false, pollingInterval } = options;

  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const [state, setState] = useState<UseAPIState<T>>({
    data: null,
    loading: !skip,
    refreshing: false,
    error: null,
  });

  // Identifies the active (key, skip) epoch so late responses can be ignored.
  const epochRef = useRef(0);
  const runRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    if (skip) {
      setState({ data: null, loading: false, refreshing: false, error: null });
      runRef.current = () => Promise.resolve();
      return;
    }

    const epoch = ++epochRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    // A new key means different data: do not show the old key's rows.
    setState({ data: null, loading: true, refreshing: false, error: null });

    const schedule = (): void => {
      if (disposed || !pollingInterval) return;
      timer = setTimeout(() => void run(), pollingInterval);
    };

    const run = async (): Promise<void> => {
      if (disposed) return;
      if (document.visibilityState === 'hidden') {
        schedule();
        return;
      }

      setState((previous) => ({ ...previous, refreshing: true }));
      try {
        const data = await fetcherRef.current();
        if (disposed || epoch !== epochRef.current) return;
        setState({ data, loading: false, refreshing: false, error: null });
      } catch (error) {
        if (disposed || epoch !== epochRef.current) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error: messageOf(error),
        }));
      }
      schedule();
    };

    // Manual refetch: restart the cycle so a poll cannot overlap it.
    runRef.current = async (): Promise<void> => {
      if (timer) clearTimeout(timer);
      await run();
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && pollingInterval) {
        if (timer) clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    void run();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, skip, pollingInterval]);

  const refetch = useCallback((): Promise<void> => runRef.current(), []);

  return { ...state, refetch };
}

// ---- Specific hooks ----

const POLL_FAST_MS = 5_000;
const POLL_SLOW_MS = 10_000;

export function useJobs(
  params: ListJobsParams,
  options: UseAPIOptions = { pollingInterval: POLL_SLOW_MS }
) {
  return useAPI(
    `jobs:${JSON.stringify(params)}`,
    () => apiClient.listJobs(params),
    options
  );
}

export function useJob(id: string, options: UseAPIOptions = {}) {
  return useAPI(`job:${id}`, () => apiClient.getJob(id), options);
}

export function useWorkers(
  status: WorkerStatus | undefined,
  options: UseAPIOptions = { pollingInterval: POLL_SLOW_MS }
) {
  return useAPI(
    `workers:${status ?? 'all'}`,
    () => apiClient.listWorkers({ status }),
    options
  );
}

export function useQueueOverview(
  options: UseAPIOptions = { pollingInterval: POLL_SLOW_MS }
) {
  return useAPI('queue-overview', () => apiClient.getQueueOverview(), options);
}

export function useReadiness(
  options: UseAPIOptions = { pollingInterval: POLL_SLOW_MS }
) {
  return useAPI('readiness', () => apiClient.readiness(), options);
}

export function useDashboardSnapshot(
  options: UseAPIOptions = { pollingInterval: POLL_FAST_MS }
) {
  return useAPI(
    'dashboard-snapshot',
    () => apiClient.getDashboardSnapshot(),
    options
  );
}
