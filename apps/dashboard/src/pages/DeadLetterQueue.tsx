import { useState } from 'react';
import { useJobs } from '@/hooks/useAPI';
import { apiClient } from '@/lib/api-client';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorMessage from '@/components/ErrorMessage';
import Notice from '@/components/Notice';
import Pagination from '@/components/Pagination';
import JobDetailModal from '@/components/JobDetailModal';
import { formatRelativeTime, summarizeError } from '@/lib/utils';
import styles from './DeadLetterQueue.module.css';

const PAGE_SIZE = 25;

export default function DeadLetterQueue() {
  const [offset, setOffset] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retriedAs, setRetriedAs] = useState<string | null>(null);

  const { data, loading, error, refetch } = useJobs(
    { status: 'DEAD_LETTERED', limit: PAGE_SIZE, offset },
    { pollingInterval: 10_000 }
  );

  const handleRetry = async (jobId: string): Promise<void> => {
    setRetryingId(jobId);
    setRetryError(null);
    setRetriedAs(null);
    try {
      // Creates a new job; the dead-lettered original stays as the record.
      const replacement = await apiClient.retryJob(jobId);
      setRetriedAs(replacement.id);
      await refetch();
    } catch (err) {
      setRetryError(
        err instanceof Error ? err.message : 'Failed to retry the job'
      );
    } finally {
      setRetryingId(null);
    }
  };

  if (loading) return <LoadingSpinner text="Loading dead letter queue…" />;
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
          <h1 className={styles.title}>Dead Letter Queue</h1>
          <p className={styles.subtitle}>
            {total} dead-lettered {total === 1 ? 'job' : 'jobs'}
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
      {retryError && (
        <Notice onDismiss={() => setRetryError(null)}>{retryError}</Notice>
      )}
      {retriedAs && (
        <Notice tone="success" onDismiss={() => setRetriedAs(null)}>
          Replacement job <code>{retriedAs}</code> was created.
        </Notice>
      )}

      {jobs.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon} aria-hidden="true">
            🎉
          </div>
          <h3 className={styles.emptyTitle}>No dead-lettered jobs</h3>
          <p className={styles.emptyMessage}>
            Jobs that exhaust their retries or fail permanently appear here.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.warningBox}>
            <div className={styles.warningIcon} aria-hidden="true">
              💀
            </div>
            <div className={styles.warningContent}>
              <h3 className={styles.warningTitle}>Needs attention</h3>
              <p className={styles.warningMessage}>
                These jobs ran out of attempts or failed with a permanent error.
                Review the error, then retry. A retry creates a new job and
                leaves the original here as a record.
              </p>
            </div>
          </div>

          <div className={styles.tableContainer}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Type</th>
                  <th scope="col">Queue</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Dead-lettered</th>
                  <th scope="col">Error</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const message = summarizeError(job.error);
                  return (
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
                        <span className={styles.attemptsValue}>
                          {job.attempts} / {job.maxAttempts}
                        </span>
                      </td>
                      <td className={styles.dateCell}>
                        {job.completedAt
                          ? formatRelativeTime(job.completedAt)
                          : '—'}
                      </td>
                      <td className={styles.errorCell}>
                        <div className={styles.errorText} title={message}>
                          {message
                            ? message.length > 60
                              ? `${message.substring(0, 60)}…`
                              : message
                            : 'No error message'}
                        </div>
                      </td>
                      <td className={styles.actionCell}>
                        <button
                          type="button"
                          className={styles.requeueButton}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRetry(job.id);
                          }}
                          disabled={retryingId !== null}
                        >
                          {retryingId === job.id ? 'Retrying…' : 'Retry'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
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
