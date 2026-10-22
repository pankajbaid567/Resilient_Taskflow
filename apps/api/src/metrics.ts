import type { MetricsSnapshot } from '@taskflow/database';
import {
  dlqDepth,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  jobsCurrentByStatus,
  jobsSubmittedTotal,
  queueDepth,
  queueLagSeconds,
  workersActive,
  workersLive,
} from '@taskflow/observability';
import { JobStatus } from '@taskflow/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Label values must come from a small fixed set. A raw URL contains job IDs
 * and a raw method is whatever the client sent, either of which would create a
 * new time series per request.
 */
const KNOWN_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** Route pattern such as `/api/v1/jobs/:id`, or `unmatched` for 404s. */
function routeLabel(request: FastifyRequest): string {
  return request.routeOptions.url ?? 'unmatched';
}

/** Record one finished request. Called from an `onResponse` hook. */
export function recordHttpRequest(
  request: FastifyRequest,
  reply: FastifyReply
): void {
  try {
    const labels = {
      method: KNOWN_METHODS.has(request.method) ? request.method : 'OTHER',
      path: routeLabel(request),
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels, 1);
    httpRequestDurationSeconds.observe(labels, reply.elapsedTime / 1000);
  } catch {
    // Metrics must never fail a request.
  }
}

/**
 * Count an accepted job submission. The job `type` is deliberately NOT a
 * label: it is chosen by the caller, so it is unbounded. Per-type counts come
 * from the worker, which only labels types it has a handler for.
 */
export function recordJobSubmitted(queue: string, priority: string): void {
  try {
    jobsSubmittedTotal.inc({ queue, priority }, 1);
  } catch {
    // Metrics must never fail a request.
  }
}

/**
 * Publish system-wide gauges from a database snapshot.
 *
 * These describe shared state, so every scrape recomputes them from
 * PostgreSQL rather than relying on any single process's memory. Each gauge is
 * reset first so a queue or priority that emptied disappears instead of
 * keeping its last value forever.
 */
export function publishSystemGauges(snapshot: MetricsSnapshot): void {
  jobsCurrentByStatus.reset();
  queueDepth.reset();
  queueLagSeconds.reset();
  workersActive.reset();
  dlqDepth.reset();

  // Every status appears for every queue that has any job, as zero when empty,
  // so panels do not show gaps when a count drops to 0.
  const queues = new Set(snapshot.jobs.map((row) => row.queue));
  for (const queue of queues) {
    for (const status of Object.values(JobStatus)) {
      jobsCurrentByStatus.set({ status, queue }, 0);
    }
  }
  for (const row of snapshot.jobs) {
    jobsCurrentByStatus.set(
      { status: row.status, queue: row.queue },
      row.count
    );
    if (row.status === String(JobStatus.DEAD_LETTERED)) {
      dlqDepth.set({ queue: row.queue }, row.count);
    }
  }

  const oldestByQueue = new Map<string, number>();
  for (const row of snapshot.backlog) {
    queueDepth.set({ queue: row.queue, priority: row.priority }, row.depth);
    oldestByQueue.set(
      row.queue,
      Math.max(oldestByQueue.get(row.queue) ?? 0, row.oldestAgeSeconds)
    );
  }
  for (const [queue, ageSeconds] of oldestByQueue) {
    queueLagSeconds.set({ queue }, ageSeconds);
  }

  for (const row of snapshot.liveWorkers) {
    workersActive.set({ queue: row.queue }, row.workers);
  }
  workersLive.set(snapshot.liveWorkerTotal);
}
