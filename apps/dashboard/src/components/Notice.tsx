import styles from './Notice.module.css';

interface NoticeProps {
  tone?: 'error' | 'success';
  children: React.ReactNode;
  onDismiss?: () => void;
}

/** Inline result of a user action (a failed cancel, a 403 on an admin button). */
export default function Notice({
  tone = 'error',
  children,
  onDismiss,
}: NoticeProps) {
  return (
    <div
      className={`${styles.notice} ${styles[tone]}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className={styles.text}>{children}</span>
      {onDismiss && (
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss message"
        >
          ✕
        </button>
      )}
    </div>
  );
}
