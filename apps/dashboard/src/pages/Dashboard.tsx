import { useEffect, useRef, useState } from 'react';
import { useDashboardSnapshot, useReadiness } from '@/hooks/useAPI';
import MetricCard from '@/components/MetricCard';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import Notice from '@/components/Notice';
import { formatLatency, formatNumber } from '@/lib/utils';
import styles from './Dashboard.module.css';

/**
 * Jobs finished per second between the two most recent refreshes. The API has
 * no throughput endpoint, so this is a measured delta of the succeeded count:
 * `null` until two samples exist, or if the count fell (for example after a
 * retention purge), rather than a guess.
 */
function useThroughput(
  succeeded: number | undefined,
  takenAt: number | undefined
): number | null {
  const previous = useRef<{ succeeded: number; at: number } | null>(null);
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    if (succeeded === undefined || takenAt === undefined) return;
    const before = previous.current;
    previous.current = { succeeded, at: takenAt };

    if (before && succeeded >= before.succeeded && takenAt > before.at) {
      setRate((succeeded - before.succeeded) / ((takenAt - before.at) / 1000));
    } else {
      setRate(null);
    }
  }, [succeeded, takenAt]);

  return rate;
}

export default function Dashboard() {
  const {
    data: snapshot,
    loading,
    error,
    refetch,
  } = useDashboardSnapshot({ pollingInterval: 5_000 });
  const { data: readiness, error: readinessError } = useReadiness({
    pollingInterval: 10_000,
  });
  const throughput = useThroughput(
    snapshot?.totals.succeeded,
    snapshot?.takenAt
  );

  if (loading) return <LoadingSpinner text="Loading dashboard…" />;
  if (error && !snapshot) {
    return <ErrorMessage message={error} onRetry={() => void refetch()} />;
  }
  if (!snapshot) return <ErrorMessage message="No data available" />;

  const { totals } = snapshot;
  const ready = readiness?.status === 'ready';
  const readinessLabel = readinessError
    ? 'API unreachable'
    : readiness
      ? ready
        ? 'System ready'
        : 'System not ready'
      : 'Checking…';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Dashboard</h1>
          <p className={styles.subtitle}>Live overview, refreshed every 5s</p>
        </div>
        <div className={styles.healthBadge} role="status">
          <span
            className={`${styles.statusDot} ${
              ready ? styles.healthy : styles.unhealthy
            }`}
            aria-hidden="true"
          />
          {readinessLabel}
        </div>
      </div>

      {error && <Notice>Refresh failed: {error}</Notice>}

      <div className={styles.metricsGrid}>
        <MetricCard
          title="Active Workers"
          value={snapshot.activeWorkers}
          icon="👷"
          subtitle="Heartbeating now"
          color="primary"
        />
        <MetricCard
          title="Queued Jobs"
          value={formatNumber(totals.queued)}
          icon="📋"
          subtitle="Waiting for a worker"
          color="warning"
        />
        <MetricCard
          title="Processing"
          value={formatNumber(totals.processing)}
          icon="⚙️"
          subtitle="Running now"
          color="primary"
        />
        <MetricCard
          title="Success Rate"
          value={
            snapshot.successRate === null
              ? '—'
              : `${snapshot.successRate.toFixed(1)}%`
          }
          icon="✅"
          subtitle={`${formatNumber(totals.succeeded)} succeeded`}
          color="success"
        />
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Performance</h2>
        <div className={styles.metricsGrid}>
          <MetricCard
            title="Avg Run Time"
            value={
              snapshot.avgDurationMs === null
                ? '—'
                : formatLatency(snapshot.avgDurationMs)
            }
            icon="⏱️"
            subtitle="Succeeded jobs, started to finished"
            color="primary"
          />
          <MetricCard
            title="Throughput"
            value={throughput === null ? '—' : throughput.toFixed(1)}
            icon="🚀"
            subtitle="Jobs/s since last refresh"
            color="success"
          />
          <MetricCard
            title="Redis Stream Entries"
            value={formatNumber(totals.redisDepth)}
            icon="📦"
            subtitle="Includes acknowledged entries until trimmed"
            color="primary"
          />
          <MetricCard
            title="Failed Jobs"
            value={formatNumber(totals.failed)}
            icon="❌"
            subtitle="Failed or dead-lettered"
            color="danger"
          />
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>System health</h2>
        <div className={styles.healthGrid}>
          <div className={styles.healthCard}>
            <div className={styles.healthHeader}>
              <span className={styles.serviceName}>API readiness</span>
              <span
                className={`${styles.statusBadge} ${
                  ready ? styles.up : styles.down
                }`}
              >
                {readinessError ? 'unreachable' : ready ? 'up' : 'down'}
              </span>
            </div>
            <div className={styles.responseTime}>
              PostgreSQL and Redis connectivity
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
