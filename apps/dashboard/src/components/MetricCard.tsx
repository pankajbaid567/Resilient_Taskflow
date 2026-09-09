import styles from './MetricCard.module.css';

interface MetricCardProps {
  title: string;
  value: string | number;
  icon?: string;
  subtitle?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  color?: 'primary' | 'success' | 'warning' | 'danger';
}

export default function MetricCard({
  title,
  value,
  icon,
  subtitle,
  trend,
  color = 'primary',
}: MetricCardProps) {
  return (
    <div className={`${styles.card} ${styles[color]}`}>
      <div className={styles.header}>
        <h3 className={styles.title}>{title}</h3>
        {icon && <span className={styles.icon}>{icon}</span>}
      </div>
      <div className={styles.value}>{value}</div>
      {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      {trend && (
        <div
          className={`${styles.trend} ${
            trend.isPositive ? styles.positive : styles.negative
          }`}
        >
          {trend.isPositive ? '↑' : '↓'} {Math.abs(trend.value)}%
        </div>
      )}
    </div>
  );
}
