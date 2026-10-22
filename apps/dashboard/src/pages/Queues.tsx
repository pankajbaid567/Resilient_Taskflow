import { useState } from 'react';
import { useQueueOverview } from '@/hooks/useAPI';
import { apiClient, APIError } from '@/lib/api-client';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import Notice from '@/components/Notice';
import { formatLatency, formatNumber } from '@/lib/utils';
import type { QueueOverview } from '@/types';
import styles from './Queues.module.css';

function describeActionError(error: unknown, action: string): string {
  if (error instanceof APIError && error.statusCode === 403) {
    return `Admin role required to ${action} a queue.`;
  }
  return error instanceof Error ? error.message : `Could not ${action} queue`;
}

export default function Queues() {
  const { data, loading, error, refetch } = useQueueOverview({
    pollingInterval: 5_000,
  });
  const [busyQueue, setBusyQueue] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggle = async (name: string, isActive: boolean): Promise<void> => {
    const action = isActive ? 'pause' : 'resume';
    setBusyQueue(name);
    setActionError(null);
    try {
      if (isActive) await apiClient.pauseQueue(name);
      else await apiClient.resumeQueue(name);
      await refetch();
    } catch (err) {
      setActionError(describeActionError(err, action));
    } finally {
      setBusyQueue(null);
    }
  };

  if (loading) return <LoadingSpinner text="Loading queues…" />;
  if (error && !data) {
    return <ErrorMessage message={error} onRetry={() => void refetch()} />;
  }

  const queues = data ?? [];

  if (queues.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.title}>Queues</h1>
        </div>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon} aria-hidden="true">
            📦
          </div>
          <h3 className={styles.emptyTitle}>No queues configured</h3>
          <p className={styles.emptyMessage}>
            Run <code>pnpm db:seed</code> to create the default queues.
          </p>
        </div>
      </div>
    );
  }

  const sum = (pick: (o: QueueOverview) => number): number =>
    queues.reduce((total, overview) => total + pick(overview), 0);
  const totalQueued = sum((o) => o.stats.jobs.queued);
  const totalProcessing = sum((o) => o.stats.jobs.processing);
  const totalSucceeded = sum((o) => o.stats.jobs.succeeded);
  const totalFailed = sum((o) => o.stats.jobs.failed);
  const finished = totalSucceeded + totalFailed;
  const successRate = finished > 0 ? (totalSucceeded / finished) * 100 : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Queues</h1>
          <p className={styles.subtitle}>
            {queues.length} {queues.length === 1 ? 'queue' : 'queues'},{' '}
            {queues.filter((o) => o.queue.isActive).length} accepting work
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
      {actionError && (
        <Notice onDismiss={() => setActionError(null)}>{actionError}</Notice>
      )}

      <div className={styles.statsGrid}>
        <Stat icon="⏳" label="Queued" value={formatNumber(totalQueued)} />
        <Stat
          icon="⚙️"
          label="Processing"
          value={formatNumber(totalProcessing)}
        />
        <Stat
          icon="✅"
          label="Succeeded"
          value={formatNumber(totalSucceeded)}
        />
        <Stat
          icon="📊"
          label="Success rate"
          value={successRate === null ? '—' : `${successRate.toFixed(1)}%`}
        />
      </div>

      <div className={styles.queuesGrid}>
        {queues.map((overview) => (
          <QueueCard
            key={overview.queue.name}
            overview={overview}
            busy={busyQueue === overview.queue.name}
            onToggle={() =>
              void toggle(overview.queue.name, overview.queue.isActive)
            }
          />
        ))}
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statIcon} aria-hidden="true">
        {icon}
      </div>
      <div className={styles.statContent}>
        <div className={styles.statValue}>{value}</div>
        <div className={styles.statLabel}>{label}</div>
      </div>
    </div>
  );
}

function QueueCard({
  overview,
  busy,
  onToggle,
}: {
  overview: QueueOverview;
  busy: boolean;
  onToggle: () => void;
}) {
  const { queue, stats } = overview;
  const { queued, processing, succeeded, failed } = stats.jobs;
  const total = queued + processing + succeeded + failed;
  const finished = succeeded + failed;
  const successRate = finished > 0 ? (succeeded / finished) * 100 : null;
  const share = (n: number): string => `${total > 0 ? (n / total) * 100 : 0}%`;

  return (
    <div className={styles.queueCard}>
      <div className={styles.queueHeader}>
        <div>
          <h3 className={styles.queueName}>{queue.name}</h3>
          <span
            className={`${styles.stateBadge} ${
              queue.isActive ? styles.stateActive : styles.statePaused
            }`}
          >
            {queue.isActive ? 'Accepting work' : 'Paused'}
          </span>
        </div>
        <div className={styles.queueTotal}>{formatNumber(total)} jobs</div>
      </div>

      <div className={styles.statusGrid}>
        <StatusItem label="Queued" value={queued} variant={styles.queued} />
        <StatusItem
          label="Processing"
          value={processing}
          variant={styles.processing}
        />
        <StatusItem
          label="Succeeded"
          value={succeeded}
          variant={styles.completed}
        />
        <StatusItem label="Failed" value={failed} variant={styles.failed} />
      </div>

      <div className={styles.metricsSection}>
        <Metric
          label="Success rate"
          value={successRate === null ? '—' : `${successRate.toFixed(1)}%`}
          tone={
            successRate === null
              ? undefined
              : successRate >= 95
                ? styles.success
                : successRate >= 80
                  ? styles.warning
                  : styles.danger
          }
        />
        <Metric
          label="Avg run time"
          value={
            succeeded > 0 && Number.isFinite(stats.performance.avgDurationMs)
              ? formatLatency(stats.performance.avgDurationMs)
              : '—'
          }
        />
        <Metric
          label="Stream entries"
          value={formatNumber(stats.redis.depth)}
        />
        <Metric label="Active workers" value={String(stats.workers.active)} />
      </div>

      <dl className={styles.config}>
        <div>
          <dt>Retries</dt>
          <dd>{queue.maxRetryAttempts}</dd>
        </div>
        <div>
          <dt>Timeout</dt>
          <dd>{formatLatency(queue.defaultTimeoutMs)}</dd>
        </div>
        <div>
          <dt>Concurrency</dt>
          <dd>{queue.concurrencyLimit ?? 'unlimited'}</dd>
        </div>
      </dl>

      <div
        className={styles.statusBar}
        role="img"
        aria-label={`${succeeded} succeeded, ${processing} processing, ${queued} queued, ${failed} failed`}
      >
        {succeeded > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.completedSegment}`}
            style={{ width: share(succeeded) }}
          />
        )}
        {processing > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.processingSegment}`}
            style={{ width: share(processing) }}
          />
        )}
        {queued > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.queuedSegment}`}
            style={{ width: share(queued) }}
          />
        )}
        {failed > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.failedSegment}`}
            style={{ width: share(failed) }}
          />
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={queue.isActive ? styles.pauseButton : styles.resumeButton}
          onClick={onToggle}
          disabled={busy}
          title="Admin only"
        >
          {busy ? 'Working…' : queue.isActive ? 'Pause queue' : 'Resume queue'}
        </button>
      </div>
    </div>
  );
}

function StatusItem({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: string | undefined;
}) {
  return (
    <div className={styles.statusItem}>
      <div className={styles.statusLabel}>{label}</div>
      <div className={`${styles.statusValue} ${variant ?? ''}`}>
        {formatNumber(value)}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={styles.metricItem}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={`${styles.metricValue} ${tone ?? ''}`}>{value}</div>
    </div>
  );
}
