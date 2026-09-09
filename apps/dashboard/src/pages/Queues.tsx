import { useQueues } from '@/hooks/useAPI';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import { formatNumber } from '@/lib/utils';
import type { QueueStats } from '@/types';
import styles from './Queues.module.css';

export default function Queues() {
  const { data: queues, loading, error, refetch } = useQueues({
    pollingInterval: 5000,
  });

  if (loading && !queues) {
    return <LoadingSpinner text="Loading queues..." />;
  }

  if (error) {
    return <ErrorMessage message={error} onRetry={refetch} />;
  }

  if (!queues || queues.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.title}>Queues</h1>
        </div>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>📦</div>
          <h3 className={styles.emptyTitle}>No queues found</h3>
          <p className={styles.emptyMessage}>
            Queues will appear here when jobs are submitted
          </p>
        </div>
      </div>
    );
  }

  const totalJobs = queues.reduce((sum, q) => sum + q.total, 0);
  const totalQueued = queues.reduce((sum, q) => sum + q.queued, 0);
  const totalProcessing = queues.reduce((sum, q) => sum + q.processing, 0);
  const totalCompleted = queues.reduce((sum, q) => sum + q.completed, 0);
  const totalFailed = queues.reduce((sum, q) => sum + q.failed, 0);

  const overallSuccessRate =
    totalCompleted + totalFailed > 0
      ? (totalCompleted / (totalCompleted + totalFailed)) * 100
      : 100;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Queues</h1>
          <p className={styles.subtitle}>{queues.length} active queues</p>
        </div>
        <button className={styles.refreshButton} onClick={refetch}>
          🔄 Refresh
        </button>
      </div>

      {/* Overall Stats */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>📊</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{formatNumber(totalJobs)}</div>
            <div className={styles.statLabel}>Total Jobs</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>⏳</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{formatNumber(totalQueued)}</div>
            <div className={styles.statLabel}>Queued</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>⚙️</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>
              {formatNumber(totalProcessing)}
            </div>
            <div className={styles.statLabel}>Processing</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>✅</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>
              {overallSuccessRate.toFixed(1)}%
            </div>
            <div className={styles.statLabel}>Success Rate</div>
          </div>
        </div>
      </div>

      {/* Queue Cards */}
      <div className={styles.queuesGrid}>
        {queues.map((queue) => (
          <QueueCard key={queue.name} queue={queue} />
        ))}
      </div>
    </div>
  );
}

function QueueCard({ queue }: { queue: QueueStats }) {
  const successRate =
    queue.completed + queue.failed > 0
      ? (queue.completed / (queue.completed + queue.failed)) * 100
      : 100;

  return (
    <div className={styles.queueCard}>
      <div className={styles.queueHeader}>
        <h3 className={styles.queueName}>{queue.name}</h3>
        <div className={styles.queueTotal}>{formatNumber(queue.total)} jobs</div>
      </div>

      {/* Status Breakdown */}
      <div className={styles.statusGrid}>
        <div className={styles.statusItem}>
          <div className={styles.statusLabel}>Queued</div>
          <div className={`${styles.statusValue} ${styles.queued}`}>
            {formatNumber(queue.queued)}
          </div>
        </div>
        <div className={styles.statusItem}>
          <div className={styles.statusLabel}>Processing</div>
          <div className={`${styles.statusValue} ${styles.processing}`}>
            {formatNumber(queue.processing)}
          </div>
        </div>
        <div className={styles.statusItem}>
          <div className={styles.statusLabel}>Completed</div>
          <div className={`${styles.statusValue} ${styles.completed}`}>
            {formatNumber(queue.completed)}
          </div>
        </div>
        <div className={styles.statusItem}>
          <div className={styles.statusLabel}>Failed</div>
          <div className={`${styles.statusValue} ${styles.failed}`}>
            {formatNumber(queue.failed)}
          </div>
        </div>
      </div>

      {/* Priority Breakdown */}
      {queue.byPriority && Object.keys(queue.byPriority).length > 0 && (
        <div className={styles.prioritySection}>
          <div className={styles.sectionTitle}>By Priority</div>
          <div className={styles.priorityGrid}>
            {Object.entries(queue.byPriority)
              .sort(([a], [b]) => Number(b) - Number(a))
              .map(([priority, count]) => (
                <div key={priority} className={styles.priorityItem}>
                  <span
                    className={`${styles.priorityBadge} ${
                      Number(priority) >= 8
                        ? styles.priorityHigh
                        : Number(priority) >= 5
                        ? styles.priorityMedium
                        : styles.priorityLow
                    }`}
                  >
                    P{priority}
                  </span>
                  <span className={styles.priorityCount}>
                    {formatNumber(count)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Metrics */}
      <div className={styles.metricsSection}>
        <div className={styles.metricItem}>
          <div className={styles.metricLabel}>Success Rate</div>
          <div
            className={`${styles.metricValue} ${
              successRate >= 95
                ? styles.success
                : successRate >= 80
                ? styles.warning
                : styles.danger
            }`}
          >
            {successRate.toFixed(1)}%
          </div>
        </div>
        {queue.avgProcessingTime !== undefined && (
          <div className={styles.metricItem}>
            <div className={styles.metricLabel}>Avg Processing Time</div>
            <div className={styles.metricValue}>
              {queue.avgProcessingTime < 1000
                ? `${queue.avgProcessingTime.toFixed(0)}ms`
                : `${(queue.avgProcessingTime / 1000).toFixed(2)}s`}
            </div>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className={styles.statusBar}>
        {queue.completed > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.completedSegment}`}
            style={{
              width: `${(queue.completed / queue.total) * 100}%`,
            }}
            title={`Completed: ${queue.completed}`}
          />
        )}
        {queue.processing > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.processingSegment}`}
            style={{
              width: `${(queue.processing / queue.total) * 100}%`,
            }}
            title={`Processing: ${queue.processing}`}
          />
        )}
        {queue.queued > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.queuedSegment}`}
            style={{
              width: `${(queue.queued / queue.total) * 100}%`,
            }}
            title={`Queued: ${queue.queued}`}
          />
        )}
        {queue.failed > 0 && (
          <div
            className={`${styles.statusSegment} ${styles.failedSegment}`}
            style={{
              width: `${(queue.failed / queue.total) * 100}%`,
            }}
            title={`Failed: ${queue.failed}`}
          />
        )}
      </div>
    </div>
  );
}
