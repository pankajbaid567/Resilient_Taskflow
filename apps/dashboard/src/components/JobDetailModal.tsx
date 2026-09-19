import { useState } from 'react';
import Modal from './Modal';
import StatusBadge from './StatusBadge';
import LoadingSpinner from './LoadingSpinner';
import { useJob } from '@/hooks/useAPI';
import { apiClient } from '@/lib/api-client';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import styles from './JobDetailModal.module.css';

interface JobDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  jobId: string;
  onJobUpdated?: () => void;
}

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
  } = useJob(jobId, { skip: !isOpen });
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCancel = async () => {
    if (!job) return;

    setActionLoading('cancel');
    setActionError(null);

    try {
      await apiClient.cancelJob(job.id);
      await refetch();
      onJobUpdated?.();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to cancel job'
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async () => {
    if (!job) return;

    setActionLoading('retry');
    setActionError(null);

    try {
      await apiClient.retryJob(job.id);
      await refetch();
      onJobUpdated?.();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to retry job'
      );
    } finally {
      setActionLoading(null);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Job Details" size="large">
      {loading && <LoadingSpinner text="Loading job details..." />}

      {error && (
        <div className={styles.error}>
          <p>Error: {error}</p>
          <button onClick={() => refetch()} className={styles.retryButton}>
            Retry
          </button>
        </div>
      )}

      {job && (
        <div className={styles.container}>
          {/* Header */}
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h3 className={styles.jobId}>{job.id}</h3>
              <StatusBadge status={job.status} />
            </div>
            <div className={styles.actions}>
              {job.status === 'queued' || job.status === 'processing' ? (
                <button
                  className={styles.cancelButton}
                  onClick={handleCancel}
                  disabled={actionLoading === 'cancel'}
                >
                  {actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel Job'}
                </button>
              ) : null}
              {job.status === 'failed' && (
                <button
                  className={styles.retryButton}
                  onClick={handleRetry}
                  disabled={actionLoading === 'retry'}
                >
                  {actionLoading === 'retry' ? 'Retrying...' : 'Retry Job'}
                </button>
              )}
            </div>
          </div>

          {actionError && (
            <div className={styles.actionError}>{actionError}</div>
          )}

          {/* Info Grid */}
          <div className={styles.infoGrid}>
            <InfoItem label="Type" value={job.type} />
            <InfoItem label="Queue" value={job.queue} />
            <InfoItem label="Priority" value={job.priority} />
            <InfoItem
              label="Attempts"
              value={`${job.attempts} / ${job.maxAttempts}`}
            />
            <InfoItem label="Timeout" value={`${job.timeout}ms`} />
            {job.workerId && (
              <InfoItem label="Worker ID" value={job.workerId} />
            )}
          </div>

          {/* Timestamps */}
          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>Timeline</h4>
            <div className={styles.timeline}>
              <TimelineItem label="Created" date={job.createdAt} icon="📝" />
              {job.scheduledAt && (
                <TimelineItem
                  label="Scheduled"
                  date={job.scheduledAt}
                  icon="⏰"
                />
              )}
              {job.startedAt && (
                <TimelineItem label="Started" date={job.startedAt} icon="▶️" />
              )}
              {job.completedAt && (
                <TimelineItem
                  label="Completed"
                  date={job.completedAt}
                  icon="✅"
                />
              )}
              {job.failedAt && (
                <TimelineItem label="Failed" date={job.failedAt} icon="❌" />
              )}
            </div>
          </div>

          {/* Payload */}
          <div className={styles.section}>
            <h4 className={styles.sectionTitle}>Payload</h4>
            <pre className={styles.codeBlock}>
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {job.result && (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>Result</h4>
              <pre className={styles.codeBlock}>
                {JSON.stringify(job.result, null, 2)}
              </pre>
            </div>
          )}

          {/* Error */}
          {job.error && (
            <div className={styles.section}>
              <h4 className={styles.sectionTitle}>Error</h4>
              <div className={styles.errorBox}>{job.error}</div>
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
      <span className={styles.timelineIcon}>{icon}</span>
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
