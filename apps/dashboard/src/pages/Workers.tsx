import { useId, useState } from 'react';
import { useWorkers } from '@/hooks/useAPI';
import { apiClient, APIError } from '@/lib/api-client';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import Notice from '@/components/Notice';
import {
  formatNumber,
  formatRelativeTime,
  humanizeStatus,
  isHeartbeatFresh,
} from '@/lib/utils';
import type { Worker, WorkerStatus } from '@/types';
import styles from './Workers.module.css';

type Filter = WorkerStatus | 'ALL';

const FILTERS: Filter[] = [
  'ACTIVE',
  'STARTING',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'ALL',
];

const STATUS_CLASS: Record<WorkerStatus, string | undefined> = {
  ACTIVE: styles.statusActive,
  STARTING: styles.statusIdle,
  STOPPING: styles.statusStopping,
  STOPPED: styles.statusStopped,
  FAILED: styles.statusFailed,
};

export default function Workers() {
  const filterId = useId();
  const [filter, setFilter] = useState<Filter>('ACTIVE');
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'error' | 'success';
    text: string;
  } | null>(null);

  const { data, loading, error, refetch } = useWorkers(
    filter === 'ALL' ? undefined : filter,
    { pollingInterval: 5_000 }
  );

  const stop = async (worker: Worker): Promise<void> => {
    const confirmed = window.confirm(
      `Stop worker ${worker.name}? It finishes running jobs and shuts down; start a new process to replace it.`
    );
    if (!confirmed) return;

    setStoppingId(worker.id);
    setNotice(null);
    try {
      await apiClient.stopWorker(worker.id);
      setNotice({
        tone: 'success',
        text: `Stop requested for ${worker.name}. It shuts down at its next heartbeat.`,
      });
      await refetch();
    } catch (err) {
      setNotice({
        tone: 'error',
        text:
          err instanceof APIError && err.statusCode === 403
            ? 'Admin role required to stop a worker.'
            : err instanceof Error
              ? err.message
              : 'Could not stop the worker',
      });
    } finally {
      setStoppingId(null);
    }
  };

  if (loading) return <LoadingSpinner text="Loading workers…" />;
  if (error && !data) {
    return <ErrorMessage message={error} onRetry={() => void refetch()} />;
  }

  const workers = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const processed = workers.reduce((n, w) => n + w.totalJobsProcessed, 0);
  const running = workers.reduce((n, w) => n + w.currentJobs, 0);
  const capacity = workers.reduce(
    (n, w) =>
      n +
      (w.status === 'ACTIVE' && isHeartbeatFresh(w.lastHeartbeat)
        ? w.concurrency
        : 0),
    0
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Workers</h1>
          <p className={styles.subtitle}>
            {total}{' '}
            {filter === 'ALL' ? 'total' : humanizeStatus(filter).toLowerCase()}{' '}
            {total === 1 ? 'worker' : 'workers'}
          </p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void refetch()}
        >
          Refresh
        </button>
      </div>

      {error && <Notice>Refresh failed: {error}</Notice>}
      {notice && (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      )}

      <div className={styles.filterRow}>
        <label htmlFor={filterId} className={styles.filterLabel}>
          Show
        </label>
        <select
          id={filterId}
          className={styles.filterSelect}
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          {FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === 'ALL' ? 'All workers' : humanizeStatus(value)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statContent}>
            <div className={styles.statValue}>
              {running} / {capacity}
            </div>
            <div className={styles.statLabel}>
              Running / capacity (live workers)
            </div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{formatNumber(processed)}</div>
            <div className={styles.statLabel}>Total processed</div>
          </div>
        </div>
      </div>

      {workers.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon} aria-hidden="true">
            👷
          </div>
          <h3 className={styles.emptyTitle}>No workers</h3>
          <p className={styles.emptyMessage}>
            {filter === 'ACTIVE'
              ? 'Start one with pnpm dev:worker'
              : 'No workers have this status'}
          </p>
        </div>
      ) : (
        <div className={styles.workersGrid}>
          {workers.map((worker) => (
            <WorkerCard
              key={worker.id}
              worker={worker}
              stopping={stoppingId === worker.id}
              onStop={() => void stop(worker)}
            />
          ))}
        </div>
      )}
      {total > workers.length && (
        <p className={styles.timestamp}>
          Showing the {workers.length} most recent of {total} workers.
        </p>
      )}
    </div>
  );
}

function WorkerCard({
  worker,
  stopping,
  onStop,
}: {
  worker: Worker;
  stopping: boolean;
  onStop: () => void;
}) {
  const unhealthy =
    worker.status === 'ACTIVE' && !isHeartbeatFresh(worker.lastHeartbeat);
  const successRate =
    worker.totalJobsProcessed > 0
      ? (worker.totalJobsSucceeded / worker.totalJobsProcessed) * 100
      : null;
  const canStop = worker.status === 'ACTIVE' || worker.status === 'STARTING';

  return (
    <div className={styles.workerCard}>
      <div className={styles.workerHeader}>
        <div className={styles.workerInfo}>
          <div className={styles.workerId}>
            <strong>{worker.name}</strong>
            <div>
              <code>{worker.id}</code>
            </div>
          </div>
          <div
            className={`${styles.workerStatus} ${STATUS_CLASS[worker.status] ?? ''}`}
          >
            <span className={styles.statusDot} aria-hidden="true" />
            {humanizeStatus(worker.status)}
          </div>
        </div>
        {unhealthy && (
          <div className={styles.unhealthyBadge}>No recent heartbeat</div>
        )}
      </div>

      <div className={styles.workerMetrics}>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Running</div>
          <div className={styles.metricValue}>
            {worker.currentJobs} / {worker.concurrency}
          </div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Processed</div>
          <div className={styles.metricValue}>
            {formatNumber(worker.totalJobsProcessed)}
          </div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Success rate</div>
          <div className={styles.metricValue}>
            {successRate === null ? '—' : `${successRate.toFixed(1)}%`}
          </div>
        </div>
      </div>

      <div className={styles.workerQueues}>
        <div className={styles.queuesLabel}>Queues:</div>
        <div className={styles.queuesList}>
          {worker.queues.map((queue) => (
            <span key={queue} className={styles.queueTag}>
              {queue}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.workerFooter}>
        <div className={styles.timestamp}>
          {worker.hostname} · pid {worker.processId} · started{' '}
          {formatRelativeTime(worker.startedAt)}
        </div>
        <div className={styles.heartbeat}>
          Heartbeat {formatRelativeTime(worker.lastHeartbeat)}
        </div>
      </div>

      {canStop && (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.stopButton}
            onClick={onStop}
            disabled={stopping}
            title="Admin only"
          >
            {stopping ? 'Requesting…' : 'Stop worker'}
          </button>
        </div>
      )}
    </div>
  );
}
