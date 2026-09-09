import { useState } from 'react';
import { useJobs } from '@/hooks/useAPI';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import StatusBadge from '@/components/StatusBadge';
import JobDetailModal from '@/components/JobDetailModal';
import { formatRelativeTime } from '@/lib/utils';
import type { JobStatus } from '@/types';
import styles from './Jobs.module.css';

const STATUS_OPTIONS: { value: JobStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function Jobs() {
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
  const [queueFilter, setQueueFilter] = useState<string>('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const params = {
    ...(statusFilter !== 'all' && { status: statusFilter }),
    ...(queueFilter && { queue: queueFilter }),
    limit: 50,
  };

  const { data, loading, error, refetch } = useJobs(params, {
    pollingInterval: 5000,
  });

  const handleJobClick = (jobId: string) => {
    setSelectedJobId(jobId);
  };

  const handleCloseModal = () => {
    setSelectedJobId(null);
  };

  const handleJobUpdated = () => {
    refetch();
  };

  if (loading && !data) {
    return <LoadingSpinner text="Loading jobs..." />;
  }

  if (error) {
    return <ErrorMessage message={error} onRetry={refetch} />;
  }

  const jobs = data?.jobs || [];
  const total = data?.total || 0;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Jobs</h1>
          <p className={styles.subtitle}>
            {total} {total === 1 ? 'job' : 'jobs'} total
          </p>
        </div>
        <button className={styles.refreshButton} onClick={refetch}>
          🔄 Refresh
        </button>
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Status</label>
          <select
            className={styles.filterSelect}
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as JobStatus | 'all')
            }
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Queue</label>
          <input
            type="text"
            className={styles.filterInput}
            placeholder="Filter by queue..."
            value={queueFilter}
            onChange={(e) => setQueueFilter(e.target.value)}
          />
        </div>
      </div>

      {/* Jobs Table */}
      {jobs.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>📋</div>
          <h3 className={styles.emptyTitle}>No jobs found</h3>
          <p className={styles.emptyMessage}>
            {statusFilter !== 'all' || queueFilter
              ? 'Try adjusting your filters'
              : 'Jobs will appear here when they are created'}
          </p>
        </div>
      ) : (
        <div className={styles.tableContainer}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Queue</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Attempts</th>
                <th>Created</th>
                <th>Worker</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className={styles.row}
                  onClick={() => handleJobClick(job.id)}
                >
                  <td className={styles.idCell}>
                    <code>{job.id.substring(0, 8)}...</code>
                  </td>
                  <td>{job.type}</td>
                  <td>
                    <span className={styles.queueBadge}>{job.queue}</span>
                  </td>
                  <td>
                    <StatusBadge status={job.status} size="small" />
                  </td>
                  <td>
                    <span
                      className={`${styles.priority} ${
                        styles[`priority${job.priority}`]
                      }`}
                    >
                      {job.priority}
                    </span>
                  </td>
                  <td>
                    {job.attempts} / {job.maxAttempts}
                  </td>
                  <td className={styles.dateCell}>
                    {formatRelativeTime(job.createdAt)}
                  </td>
                  <td className={styles.workerCell}>
                    {job.workerId ? (
                      <code>{job.workerId.substring(0, 8)}...</code>
                    ) : (
                      <span className={styles.noWorker}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Job Detail Modal */}
      {selectedJobId && (
        <JobDetailModal
          isOpen={!!selectedJobId}
          onClose={handleCloseModal}
          jobId={selectedJobId}
          onJobUpdated={handleJobUpdated}
        />
      )}
    </div>
  );
}
