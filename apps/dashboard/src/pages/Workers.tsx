import { useWorkers } from '@/hooks/useAPI';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import { formatRelativeTime, formatNumber } from '@/lib/utils';
import type { Worker } from '@/types';
import styles from './Workers.module.css';

export default function Workers() {
  const {
    data: workers,
    loading,
    error,
    refetch,
  } = useWorkers({
    pollingInterval: 3000, // Poll every 3 seconds for real-time status
  });

  if (loading && !workers) {
    return <LoadingSpinner text="Loading workers..." />;
  }

  if (error) {
    return <ErrorMessage message={error} onRetry={refetch} />;
  }

  if (!workers || workers.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.title}>Workers</h1>
        </div>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>👷</div>
          <h3 className={styles.emptyTitle}>No workers found</h3>
          <p className={styles.emptyMessage}>
            Workers will appear here when they are started
          </p>
        </div>
      </div>
    );
  }

  const activeWorkers = workers.filter((w) => w.status === 'active');
  const idleWorkers = workers.filter((w) => w.status === 'idle');
  const stoppedWorkers = workers.filter((w) => w.status === 'stopped');

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Workers</h1>
          <p className={styles.subtitle}>{workers.length} total workers</p>
        </div>
        <button className={styles.refreshButton} onClick={refetch}>
          🔄 Refresh
        </button>
      </div>

      {/* Worker Stats */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>✅</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{activeWorkers.length}</div>
            <div className={styles.statLabel}>Active</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>⏸️</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{idleWorkers.length}</div>
            <div className={styles.statLabel}>Idle</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>⏹️</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>{stoppedWorkers.length}</div>
            <div className={styles.statLabel}>Stopped</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>📊</div>
          <div className={styles.statContent}>
            <div className={styles.statValue}>
              {formatNumber(
                workers.reduce((sum, w) => sum + w.processedJobs, 0)
              )}
            </div>
            <div className={styles.statLabel}>Total Processed</div>
          </div>
        </div>
      </div>

      {/* Workers Grid */}
      <div className={styles.workersGrid}>
        {workers.map((worker) => (
          <WorkerCard key={worker.id} worker={worker} />
        ))}
      </div>
    </div>
  );
}

function WorkerCard({ worker }: { worker: Worker }) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return styles.statusActive;
      case 'idle':
        return styles.statusIdle;
      case 'stopped':
        return styles.statusStopped;
      default:
        return '';
    }
  };

  const isHealthy = () => {
    const lastHeartbeat = new Date(worker.lastHeartbeat);
    const now = new Date();
    const secondsSinceHeartbeat =
      (now.getTime() - lastHeartbeat.getTime()) / 1000;
    return secondsSinceHeartbeat < 30; // Consider unhealthy if no heartbeat for 30s
  };

  const successRate =
    worker.processedJobs > 0
      ? ((worker.processedJobs - worker.failedJobs) / worker.processedJobs) *
        100
      : 100;

  return (
    <div className={styles.workerCard}>
      <div className={styles.workerHeader}>
        <div className={styles.workerInfo}>
          <div className={styles.workerId}>
            <code>{worker.id}</code>
          </div>
          <div
            className={`${styles.workerStatus} ${getStatusColor(worker.status)}`}
          >
            <span className={styles.statusDot} />
            {worker.status}
          </div>
        </div>
        {!isHealthy() && (
          <div className={styles.unhealthyBadge}>⚠️ Unhealthy</div>
        )}
      </div>

      <div className={styles.workerMetrics}>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Processed</div>
          <div className={styles.metricValue}>
            {formatNumber(worker.processedJobs)}
          </div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Failed</div>
          <div className={styles.metricValue}>{worker.failedJobs}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Success Rate</div>
          <div className={styles.metricValue}>{successRate.toFixed(1)}%</div>
        </div>
      </div>

      {worker.currentJob && (
        <div className={styles.currentJob}>
          <div className={styles.currentJobLabel}>Current Job:</div>
          <code className={styles.currentJobId}>
            {worker.currentJob.substring(0, 12)}...
          </code>
        </div>
      )}

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
          Started {formatRelativeTime(worker.startedAt)}
        </div>
        <div className={styles.heartbeat}>
          ❤️ {formatRelativeTime(worker.lastHeartbeat)}
        </div>
      </div>
    </div>
  );
}
