import { useDashboardMetrics, useHealth } from '@/hooks/useAPI';
import MetricCard from '@/components/MetricCard';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const {
    data: metrics,
    loading: metricsLoading,
    error: metricsError,
    refetch: refetchMetrics,
  } = useDashboardMetrics({ pollingInterval: 5000 }); // Poll every 5 seconds

  const {
    data: health,
    loading: healthLoading,
    error: healthError,
  } = useHealth({ pollingInterval: 10000 }); // Poll every 10 seconds

  if (metricsLoading || healthLoading) {
    return <LoadingSpinner text="Loading dashboard..." />;
  }

  if (metricsError) {
    return (
      <ErrorMessage
        message={metricsError}
        onRetry={refetchMetrics}
      />
    );
  }

  if (!metrics) {
    return <ErrorMessage message="No metrics data available" />;
  }

  const formatNumber = (num: number): string => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toLocaleString();
  };

  const formatLatency = (ms: number): string => {
    if (ms < 1) {
      return `${(ms * 1000).toFixed(0)}μs`;
    }
    if (ms < 1000) {
      return `${ms.toFixed(0)}ms`;
    }
    return `${(ms / 1000).toFixed(2)}s`;
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Dashboard</h1>
          <p className={styles.subtitle}>Real-time system overview</p>
        </div>
        {health && (
          <div className={styles.healthBadge}>
            <span
              className={`${styles.statusDot} ${
                health.status === 'healthy' ? styles.healthy : styles.unhealthy
              }`}
            />
            System {health.status}
          </div>
        )}
      </div>

      {/* Key Metrics */}
      <div className={styles.metricsGrid}>
        <MetricCard
          title="Active Workers"
          value={metrics.activeWorkers}
          icon="👷"
          subtitle="Currently processing jobs"
          color="primary"
        />
        <MetricCard
          title="Queued Jobs"
          value={formatNumber(metrics.queuedJobs)}
          icon="📋"
          subtitle="Waiting for processing"
          color="warning"
        />
        <MetricCard
          title="Processing"
          value={formatNumber(metrics.processingJobs)}
          icon="⚙️"
          subtitle="Jobs in progress"
          color="primary"
        />
        <MetricCard
          title="Success Rate"
          value={`${metrics.successRate.toFixed(1)}%`}
          icon="✅"
          subtitle={`${formatNumber(metrics.completedJobs)} completed`}
          color="success"
        />
      </div>

      {/* Performance Metrics */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Performance</h2>
        <div className={styles.metricsGrid}>
          <MetricCard
            title="Avg Latency"
            value={formatLatency(metrics.avgLatency)}
            icon="⏱️"
            subtitle="Average processing time"
            color="primary"
          />
          <MetricCard
            title="P95 Latency"
            value={formatLatency(metrics.p95Latency)}
            icon="📊"
            subtitle="95th percentile"
            color="primary"
          />
          <MetricCard
            title="Throughput"
            value={metrics.jobsPerSecond.toFixed(1)}
            icon="🚀"
            subtitle="Jobs per second"
            color="success"
          />
          <MetricCard
            title="Failed Jobs"
            value={formatNumber(metrics.failedJobs)}
            icon="❌"
            subtitle="Total failures"
            color="danger"
          />
        </div>
      </div>

      {/* System Health */}
      {health && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>System Health</h2>
          <div className={styles.healthGrid}>
            <div className={styles.healthCard}>
              <div className={styles.healthHeader}>
                <span className={styles.serviceName}>Database</span>
                <span
                  className={`${styles.statusBadge} ${
                    health.services.database.status === 'up'
                      ? styles.up
                      : styles.down
                  }`}
                >
                  {health.services.database.status}
                </span>
              </div>
              {health.services.database.responseTime && (
                <div className={styles.responseTime}>
                  Response: {health.services.database.responseTime}ms
                </div>
              )}
            </div>

            <div className={styles.healthCard}>
              <div className={styles.healthHeader}>
                <span className={styles.serviceName}>Redis</span>
                <span
                  className={`${styles.statusBadge} ${
                    health.services.redis.status === 'up'
                      ? styles.up
                      : styles.down
                  }`}
                >
                  {health.services.redis.status}
                </span>
              </div>
              {health.services.redis.responseTime && (
                <div className={styles.responseTime}>
                  Response: {health.services.redis.responseTime}ms
                </div>
              )}
            </div>

            {health.services.kafka && (
              <div className={styles.healthCard}>
                <div className={styles.healthHeader}>
                  <span className={styles.serviceName}>Kafka</span>
                  <span
                    className={`${styles.statusBadge} ${
                      health.services.kafka.status === 'up'
                        ? styles.up
                        : styles.down
                    }`}
                  >
                    {health.services.kafka.status}
                  </span>
                </div>
                {health.services.kafka.responseTime && (
                  <div className={styles.responseTime}>
                    Response: {health.services.kafka.responseTime}ms
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {healthError && (
        <div className={styles.healthError}>
          ⚠️ Unable to fetch health status: {healthError}
        </div>
      )}
    </div>
  );
}
