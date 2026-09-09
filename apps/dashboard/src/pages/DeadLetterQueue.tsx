import { useState } from 'react';
import { useDLQ } from '@/hooks/useAPI';
import { apiClient } from '@/lib/api-client';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import JobDetailModal from '@/components/JobDetailModal';
import { formatRelativeTime } from '@/lib/utils';
import styles from './DeadLetterQueue.module.css';

export default function DeadLetterQueue() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [requeueingId, setRequeueingId] = useState<string | null>(null);
  const [requeueError, setRequeueError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useDLQ(
    { limit: 100 },
    { pollingInterval: 10000 }
  );

  const handleJobClick = (jobId: string) => {
    setSelectedJobId(jobId);
  };

  const handleCloseModal = () => {
    setSelectedJobId(null);
  };

  const handleRequeue = async (
    jobId: string,
    e: React.MouseEvent<HTMLButtonElement>
  ) => {
    e.stopPropagation(); // Prevent row click
    setRequeueingId(jobId);
    setRequeueError(null);

    try {
      await apiClient.requeueFromDLQ(jobId);
      await refetch();
    } catch (err) {
      setRequeueError(
        err instanceof Error ? err.message : 'Failed to requeue job'
      );
    } finally {
      setRequeueingId(null);
    }
  };

  if (loading && !data) {
    return <LoadingSpinner text="Loading dead letter queue..." />;
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
          <h1 className={styles.title}>Dead Letter Queue</h1>
          <p className={styles.subtitle}>
            {total} failed {total === 1 ? 'job' : 'jobs'}
          </p>
        </div>
        <button className={styles.refreshButton} onClick={refetch}>
          🔄 Refresh
        </button>
      </div>

      {requeueError && (
        <div className={styles.errorAlert}>
          <span className={styles.errorIcon}>⚠️</span>
          {requeueError}
          <button
            className={styles.dismissButton}
            onClick={() => setRequeueError(null)}
          >
            ✕
          </button>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>🎉</div>
          <h3 className={styles.emptyTitle}>No failed jobs</h3>
          <p className={styles.emptyMessage}>
            All jobs are processing successfully!
          </p>
        </div>
      ) : (
        <>
          <div className={styles.warningBox}>
            <div className={styles.warningIcon}>💀</div>
            <div className={styles.warningContent}>
              <h3 className={styles.warningTitle}>Dead Letter Queue</h3>
              <p className={styles.warningMessage}>
                These jobs have exceeded their maximum retry attempts and require
                manual intervention. Review the error details and requeue them when
                ready.
              </p>
            </div>
          </div>

          <div className={styles.tableContainer}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Queue</th>
                  <th>Attempts</th>
                  <th>Failed At</th>
                  <th>Error</th>
                  <th>Action</th>
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
                      <span className={styles.attemptsValue}>
                        {job.attempts} / {job.maxAttempts}
                      </span>
                    </td>
                    <td className={styles.dateCell}>
                      {job.failedAt ? formatRelativeTime(job.failedAt) : '—'}
                    </td>
                    <td className={styles.errorCell}>
                      <div className={styles.errorText}>
                        {job.error
                          ? job.error.length > 60
                            ? `${job.error.substring(0, 60)}...`
                            : job.error
                          : 'No error message'}
                      </div>
                    </td>
                    <td className={styles.actionCell}>
                      <button
                        className={styles.requeueButton}
                        onClick={(e) => handleRequeue(job.id, e)}
                        disabled={requeueingId === job.id}
                      >
                        {requeueingId === job.id ? '⏳' : '🔄'}
                        {requeueingId === job.id ? ' Requeuing...' : ' Requeue'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Job Detail Modal */}
      {selectedJobId && (
        <JobDetailModal
          isOpen={!!selectedJobId}
          onClose={handleCloseModal}
          jobId={selectedJobId}
          onJobUpdated={refetch}
        />
      )}
    </div>
  );
}
