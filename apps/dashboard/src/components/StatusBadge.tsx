import styles from './StatusBadge.module.css';
import { getStatusColor } from '@/lib/utils';

interface StatusBadgeProps {
  status: string;
  size?: 'small' | 'medium';
}

export default function StatusBadge({ status, size = 'medium' }: StatusBadgeProps) {
  const color = getStatusColor(status);

  return (
    <span className={`${styles.badge} ${styles[color]} ${styles[size]}`}>
      {status}
    </span>
  );
}
