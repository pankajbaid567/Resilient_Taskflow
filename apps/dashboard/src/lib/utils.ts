import type { JobStatus } from '@/types';

export function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
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
  // Clock skew between server and browser can yield a small negative.
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));

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

  return `${Math.floor(hours / 24)}d ago`;
}

export type Tone = 'primary' | 'success' | 'warning' | 'danger';

const STATUS_TONE: Record<JobStatus, Tone> = {
  CREATED: 'primary',
  QUEUED: 'primary',
  PROCESSING: 'primary',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  RETRY_SCHEDULED: 'warning',
  DEAD_LETTERED: 'danger',
  CANCEL_REQUESTED: 'warning',
  CANCELLED: 'warning',
};

/** Colour for a job status, or for a worker status such as ACTIVE. */
export function getStatusTone(status: string): Tone {
  if (status in STATUS_TONE) return STATUS_TONE[status as JobStatus];
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'STARTING':
    case 'STOPPING':
      return 'warning';
    case 'FAILED':
      return 'danger';
    default:
      return 'primary';
  }
}

/** `RETRY_SCHEDULED` -> `Retry scheduled`. Colour is never the only signal. */
export function humanizeStatus(status: string): string {
  const words = status.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The most useful single line from a job's stored error object. */
export function summarizeError(error: Record<string, unknown> | null): string {
  if (!error) return '';
  if (typeof error.message === 'string' && error.message) return error.message;
  if (typeof error.code === 'string' && error.code) return error.code;
  return JSON.stringify(error);
}

/**
 * Workers heartbeat every 10 s by default; allow three missed beats. A worker
 * that crashed stays ACTIVE in the database, so status alone cannot be trusted.
 */
export const WORKER_STALE_AFTER_MS = 30_000;

export function isHeartbeatFresh(lastHeartbeat: string): boolean {
  return (
    Date.now() - new Date(lastHeartbeat).getTime() <= WORKER_STALE_AFTER_MS
  );
}

export const MUTABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  'CREATED',
  'QUEUED',
  'RETRY_SCHEDULED',
  'PROCESSING',
]);

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
