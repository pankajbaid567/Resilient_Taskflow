import styles from './Pagination.module.css';
import type { Pagination as PaginationInfo } from '@/types';

interface PaginationProps {
  pagination: PaginationInfo;
  onChange: (offset: number) => void;
}

export default function Pagination({ pagination, onChange }: PaginationProps) {
  const { limit, offset, total } = pagination;
  if (total <= limit) return null;

  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);

  return (
    <nav className={styles.pagination} aria-label="Pagination">
      <span className={styles.summary}>
        Showing {first}–{last} of {total}
      </span>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.button}
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
