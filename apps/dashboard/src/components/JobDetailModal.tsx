import { useState } from 'react';
import Modal from './Modal';
import StatusBadge from './StatusBadge';
import LoadingSpinner from './LoadingSpinner';
import Notice from './Notice';
import { useJob } from '@/hooks/useAPI';
import { apiClient } from '@/lib/api-client';
import {
  formatDate,
  formatRelativeTime,
  MUTABLE_STATUSES,
  summarizeError,
} from '@/lib/utils';
import styles from './JobDetailModal.module.css';

interface JobDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  jobId: string;
  onJobUpdated?: () => void;
}

type Action = 'cancel' | 'retry';

export default function JobDetailModal({
  isOpen,
  onClose,
  jobId,
  onJobUpdated,
}: JobDetailModalProps) {
  const {
    data: job,
    loading,
    error,
    refetch,
  } = useJob(jobId, { skip: !isOpen, pollingInterval: 3_000 });
  const [pending, setPending] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [replacementId, setReplacementId] = useState<string | null>(null);

  const run = async (action: Action): Promise<void> => {
    if (!job) return;
    setPending(action);
    setActionError(null);
    setReplacementId(null);

    try {
      if (action === 'cancel') {
        await apiClient.cancelJob(job.id);
      } else {
        // Retrying creates a NEW job; the dead-lettered original is kept.
        const replacement = await apiClient.retryJob(job.id);
        setReplacementId(replacement.id);
      }
      await refetch();
      onJobUpdated?.();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `Failed to ${action} job`
      );
    } finally {
      setPending(null);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Job details" size="large">
      {loading && <LoadingSpinner text="Loading job details…" />}

      {error && !job && (
        <div className={styles.error} role="alert">
          <p>Error: {error}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className={styles.retryButton}
          >
            Retry
          </button>
        </div>
      )}

      {job && (
        <div className={styles.container}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h3 className={styles.jobId}>{job.id}</h3>
              <StatusBadge status={job.status} />
            </div>
            <div className={styles.actions}>
              {MUTABLE_STATUSES.has(job.status) && (
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={() => void run('cancel')}
                  disabled={pending !== null}
                >
                  {pending === 'cancel' ? 'Cancelling…' : 'Cancel job'}
                </button>
              )}
              {job.status === 'DEAD_LETTERED' && (
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={() => void run('retry')}
                  disabled={pending !== null}
                >
                  {pending === 'retry' ? 'Retrying…' : 'Retry as new job'}
                </button>
              )}
            </div>
          </div>

          {job.status === 'CANCEL_REQUESTED' && (
            <Notice tone="success">
              Cancellation requested. The worker stops the job at its next lease
              renewal (within a few seconds).
            </Notice>
          )}
          {replacementId && (
            <Notice tone="success">
              Replacement job <code>{replacementId}</code> was created.
            </Notice>
          )}
          {actionError && (
            <Notice onDismiss={() => setActionError(null)}>
              {actionError}
            </Notice>
          )}

          <div className={styles.infoGrid}>
            <InfoItem label="Type" value={job.type} />
            <InfoItem label="Queue" value={job.queue} />
            <InfoItem label="Priority" value={job.priority} />
            <InfoItem
              label="Attempts"
              value={`${job.attempts} / ${job.maxAttempts}`}
            />
          </div>

          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>Timeline</h4>
            <div className={styles.timeline}>
              <TimelineItem label="Created" date={job.createdAt} icon="📝" />
              <TimelineItem
                label="Scheduled"
                date={job.scheduledAt}
                icon="⏰"
              />
              {job.startedAt && (
                <TimelineItem label="Started" date={job.startedAt} icon="▶️" />
              )}
              {job.completedAt && (
                <TimelineItem
                  label="Finished"
                  date={job.completedAt}
                  icon="🏁"
                />
              )}
            </div>
          </div>

          {job.result && (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>Result</h4>
              <pre className={styles.codeBlock}>
                {JSON.stringify(job.result, null, 2)}
              </pre>
            </div>
          )}

          {job.error && (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>Error</h4>
              <div className={styles.errorBox}>{summarizeError(job.error)}</div>
              <details>
                <summary>Full error record</summary>
                <pre className={styles.codeBlock}>
                  {JSON.stringify(job.error, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function InfoItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.infoItem}>
      <div className={styles.infoLabel}>{label}</div>
      <div className={styles.infoValue}>{value}</div>
    </div>
  );
}

function TimelineItem({
  label,
  date,
  icon,
}: {
  label: string;
  date: string;
  icon: string;
}) {
  return (
    <div className={styles.timelineItem}>
      <span className={styles.timelineIcon} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.timelineContent}>
        <div className={styles.timelineLabel}>{label}</div>
        <div className={styles.timelineDate}>
          {formatDate(date)}
          <span className={styles.timelineRelative}>
            ({formatRelativeTime(date)})
          </span>
        </div>
      </div>
    </div>
  );
}
