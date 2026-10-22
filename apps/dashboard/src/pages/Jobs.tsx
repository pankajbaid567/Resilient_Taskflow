import { useId, useState } from 'react';
import { useJobs } from '@/hooks/useAPI';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import Notice from '@/components/Notice';
import Pagination from '@/components/Pagination';
import StatusBadge from '@/components/StatusBadge';
import JobDetailModal from '@/components/JobDetailModal';
import { formatRelativeTime, humanizeStatus } from '@/lib/utils';
import { JOB_STATUSES, type JobStatus } from '@/types';
import styles from './Jobs.module.css';

const PAGE_SIZE = 25;

export default function Jobs() {
  const statusId = useId();
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'ALL'>('ALL');
  const [offset, setOffset] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const { data, loading, error, refetch } = useJobs(
    {
      ...(statusFilter !== 'ALL' && { status: statusFilter }),
      limit: PAGE_SIZE,
      offset,
    },
    { pollingInterval: 5_000 }
  );

  const changeStatus = (value: JobStatus | 'ALL'): void => {
    setStatusFilter(value);
    setOffset(0);
  };

  if (loading) return <LoadingSpinner text="Loading jobs…" />;
  if (error && !data) {
    return <ErrorMessage message={error} onRetry={() => void refetch()} />;
  }

  const jobs = data?.data ?? [];
  const pagination = data?.pagination;
  const total = pagination?.total ?? 0;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Jobs</h1>
          <p className={styles.subtitle}>
            {total} {total === 1 ? 'job' : 'jobs'}
            {statusFilter !== 'ALL' && ` — ${humanizeStatus(statusFilter)}`}
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

      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel} htmlFor={statusId}>
            Status
          </label>
          <select
            id={statusId}
            className={styles.filterSelect}
            value={statusFilter}
            onChange={(e) => changeStatus(e.target.value as JobStatus | 'ALL')}
          >
            <option value="ALL">All</option>
            {JOB_STATUSES.map((status) => (
              <option key={status} value={status}>
                {humanizeStatus(status)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon} aria-hidden="true">
            📋
          </div>
          <h3 className={styles.emptyTitle}>No jobs found</h3>
          <p className={styles.emptyMessage}>
            {statusFilter !== 'ALL'
              ? 'Try a different status filter'
              : 'Jobs you submit will appear here'}
          </p>
        </div>
      ) : (
        <div className={styles.tableContainer}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>Jobs</caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Type</th>
                <th scope="col">Queue</th>
                <th scope="col">Status</th>
                <th scope="col">Priority</th>
                <th scope="col">Attempts</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className={styles.row}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <td className={styles.idCell}>
                    <button
                      type="button"
                      className={styles.idButton}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedJobId(job.id);
                      }}
                      aria-label={`Open job ${job.id}`}
                    >
                      <code>{job.id.substring(0, 8)}…</code>
                    </button>
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
                        styles[`priority${job.priority}`] ?? ''
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && (
        <Pagination pagination={pagination} onChange={setOffset} />
      )}

      {selectedJobId && (
        <JobDetailModal
          isOpen
          onClose={() => setSelectedJobId(null)}
          jobId={selectedJobId}
          onJobUpdated={() => void refetch()}
        />
      )}
    </div>
  );
}
