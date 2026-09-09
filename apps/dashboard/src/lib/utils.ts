export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toLocaleString();
}

export function formatLatency(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString();
}

export function formatRelativeTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const seconds = Math.floor((now.getTime() - d.getTime()) / 1000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getStatusColor(
  status: string
): 'primary' | 'success' | 'warning' | 'danger' {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'success':
    case 'active':
      return 'success';
    case 'processing':
    case 'queued':
    case 'created':
      return 'primary';
    case 'failed':
    case 'dead_letter':
      return 'danger';
    case 'cancelled':
      return 'warning';
    default:
      return 'primary';
  }
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
