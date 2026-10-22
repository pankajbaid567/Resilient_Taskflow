import styles from './StatusBadge.module.css';
import { getStatusTone, humanizeStatus } from '@/lib/utils';

interface StatusBadgeProps {
  status: string;
  size?: 'small' | 'medium';
}

/** The label is always text, so colour is never the only signal. */
export default function StatusBadge({
  status,
  size = 'medium',
}: StatusBadgeProps) {
  const tone = getStatusTone(status);

  return (
    <span className={`${styles.badge} ${styles[tone]} ${styles[size]}`}>
      {humanizeStatus(status)}
    </span>
  );
}
