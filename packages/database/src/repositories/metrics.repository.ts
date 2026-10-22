import { sql } from 'drizzle-orm';

import { db } from '../client';

/** Jobs per queue and status (every status, including terminal ones). */
export interface QueueStatusCount {
  queue: string;
  status: string;
  count: number;
}

/** Waiting work: QUEUED jobs per queue and priority. */
export interface QueueBacklog {
  queue: string;
  priority: string;
  depth: number;
  /** Age in seconds of the oldest job in this group. */
  oldestAgeSeconds: number;
}

/** Workers that are ACTIVE *and* heartbeating, per queue they serve. */
export interface QueueLiveWorkers {
  queue: string;
  workers: number;
}

export interface MetricsSnapshot {
  jobs: QueueStatusCount[];
  backlog: QueueBacklog[];
  /** Live workers per queue they serve. One worker can appear in several. */
  liveWorkers: QueueLiveWorkers[];
  /** Distinct live workers, each counted once. */
  liveWorkerTotal: number;
}

export interface MetricsSnapshotOptions {
  /**
   * A worker whose last heartbeat is older than this is not counted. A crashed
   * worker stays ACTIVE in the database until something marks it otherwise, so
   * its status alone cannot be trusted. Default: 30 s (three missed beats).
   */
  workerStaleAfterMs?: number;
}

/**
 * Point-in-time state for the Prometheus gauges that describe the system
 * rather than one process: per-queue job counts, the waiting backlog and its
 * age, and the number of live workers.
 *
 * Three read-only aggregates, run at scrape time. Cost grows with the number
 * of retained jobs, which retention keeps bounded.
 */
export async function getMetricsSnapshot(
  options: MetricsSnapshotOptions = {}
): Promise<MetricsSnapshot> {
  const staleAfterMs = options.workerStaleAfterMs ?? 30_000;
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new RangeError('workerStaleAfterMs must be a positive integer');
  }

  const [jobs, backlog, liveWorkers, liveTotal] = await Promise.all([
    db.execute(sql`
      SELECT q.name AS queue, j.status::text AS status, count(*)::int AS count
      FROM jobs AS j
      JOIN queues AS q ON q.id = j.queue_id
      GROUP BY q.name, j.status
    `),
    db.execute(sql`
      SELECT q.name AS queue,
             j.priority::text AS priority,
             count(*)::int AS depth,
             GREATEST(
               0,
               EXTRACT(EPOCH FROM (clock_timestamp() - min(j.scheduled_at)))
             )::float8 AS "oldestAgeSeconds"
      FROM jobs AS j
      JOIN queues AS q ON q.id = j.queue_id
      WHERE j.status = 'QUEUED'
      GROUP BY q.name, j.priority
    `),
    db.execute(sql`
      SELECT served.queue AS queue, count(*)::int AS workers
      FROM workers AS w
      CROSS JOIN LATERAL unnest(w.queues) AS served(queue)
      WHERE w.status = 'ACTIVE'
        AND w.last_heartbeat_at
              > clock_timestamp() - (${staleAfterMs} * interval '1 millisecond')
      GROUP BY served.queue
    `),
    db.execute(sql`
      SELECT count(*)::int AS total
      FROM workers AS w
      WHERE w.status = 'ACTIVE'
        AND w.last_heartbeat_at
              > clock_timestamp() - (${staleAfterMs} * interval '1 millisecond')
    `),
  ]);

  return {
    jobs: [...jobs] as unknown as QueueStatusCount[],
    backlog: [...backlog] as unknown as QueueBacklog[],
    liveWorkers: [...liveWorkers] as unknown as QueueLiveWorkers[],
    liveWorkerTotal: Number(
      (liveTotal as unknown as Array<{ total: number }>)[0]?.total ?? 0
    ),
  };
}
