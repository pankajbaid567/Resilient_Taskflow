import type {
  RetentionBatchOptions,
  RetentionPolicy,
  RetentionStepError,
} from '@taskflow/types';
import { sql, type SQL } from 'drizzle-orm';

import { db } from '../client';

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 10;

/**
 * Bounded lifecycle retention.
 *
 * Every cleaner is ONE statement of the form
 *
 *   DELETE FROM t WHERE id IN (SELECT id FROM t WHERE <safety predicates>
 *                              ORDER BY ... LIMIT n FOR UPDATE SKIP LOCKED)
 *
 * so the safety predicates are evaluated against the rows the delete actually
 * locks. A separate "select ids, then delete by id" would let a row become
 * protected (a job re-leased, a delivery re-armed) between the two statements.
 * SKIP LOCKED also makes concurrent runs take disjoint batches.
 *
 * Global invariants:
 * - History tables (events, attempts, deliveries) are only purged for jobs in
 *   a terminal state. A live job's attempt row is needed to complete it, and a
 *   PUBLISHED delivery row is the safety net that lets the stale-delivery scan
 *   republish a job whose Redis entry was lost.
 * - Jobs with a live lease, a PENDING outbox row, a due-in-the-future
 *   schedule, or a dead-letter record are never purged.
 * - Workers owning an active job are never purged.
 */

/** Job states from which no further execution can occur. */
const TERMINAL_JOB_STATUSES = sql.raw(
  `'SUCCEEDED','CANCELLED','FAILED','DEAD_LETTERED'`
);

function assertBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('Retention batch size must be a positive integer');
  }
}

/** Serialize the cutoff explicitly; raw statements do not infer Date types. */
function cutoffParam(cutoffDate: Date): SQL {
  if (Number.isNaN(cutoffDate.getTime())) {
    throw new RangeError('Retention cutoff must be a valid date');
  }
  return sql`${cutoffDate.toISOString()}::timestamptz`;
}

async function deleteBatch(statement: SQL): Promise<number> {
  const rows = await db.execute(statement);
  return rows.length;
}

/**
 * Purge terminal jobs completed before the cutoff.
 *
 * Purges SUCCEEDED, CANCELLED, FAILED and DEAD_LETTERED jobs. A DEAD_LETTERED
 * job stays protected while its dead_letter_jobs record exists, so it is only
 * purged after the dead-letter retention window (dead letters are purged first
 * in {@link runDatabaseRetention}). Cascades remove the job's remaining
 * attempts, events and deliveries.
 */
export async function cleanupBoundedJobs(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM jobs
    WHERE id IN (
      SELECT j.id
      FROM jobs AS j
      WHERE j.status IN (${TERMINAL_JOB_STATUSES})
        AND (
          (j.completed_at IS NOT NULL AND j.completed_at <= ${cutoff})
          OR (j.failed_at IS NOT NULL AND j.failed_at <= ${cutoff})
        )
        AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= clock_timestamp())
        AND j.scheduled_at <= clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM job_deliveries AS d
          WHERE d.job_id = j.id AND d.status = 'PENDING'
        )
        AND NOT EXISTS (
          SELECT 1 FROM dead_letter_jobs AS dl
          WHERE dl.original_job_id = j.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM dead_letter_jobs AS dl
          WHERE dl.requeued_job_id = j.id
        )
      ORDER BY j.created_at, j.id
      LIMIT ${batchSize}
      FOR UPDATE OF j SKIP LOCKED
    )
    RETURNING id
  `);
}

/**
 * Purge job events created before the cutoff, for terminal jobs only.
 */
export async function cleanupBoundedJobEvents(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM job_events
    WHERE id IN (
      SELECT e.id
      FROM job_events AS e
      WHERE e.created_at <= ${cutoff}
        AND EXISTS (
          SELECT 1 FROM jobs AS j
          WHERE j.id = e.job_id AND j.status IN (${TERMINAL_JOB_STATUSES})
        )
      ORDER BY e.created_at, e.id
      LIMIT ${batchSize}
      FOR UPDATE OF e SKIP LOCKED
    )
    RETURNING id
  `);
}

/**
 * Purge job execution attempts started before the cutoff, for terminal jobs
 * only. A running job's open attempt row is required to complete or fail it.
 */
export async function cleanupBoundedJobAttempts(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM job_attempts
    WHERE id IN (
      SELECT a.id
      FROM job_attempts AS a
      WHERE a.started_at <= ${cutoff}
        AND EXISTS (
          SELECT 1 FROM jobs AS j
          WHERE j.id = a.job_id AND j.status IN (${TERMINAL_JOB_STATUSES})
        )
      ORDER BY a.started_at, a.id
      LIMIT ${batchSize}
      FOR UPDATE OF a SKIP LOCKED
    )
    RETURNING id
  `);
}

/**
 * Purge dead-letter records failed before the cutoff. A requeued record must
 * also have been requeued before the cutoff.
 */
export async function cleanupBoundedDeadLetters(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM dead_letter_jobs
    WHERE id IN (
      SELECT dl.id
      FROM dead_letter_jobs AS dl
      WHERE dl.failed_at <= ${cutoff}
        AND (
          dl.requeued = false
          OR (dl.requeued_at IS NOT NULL AND dl.requeued_at <= ${cutoff})
        )
      ORDER BY dl.failed_at, dl.id
      LIMIT ${batchSize}
      FOR UPDATE OF dl SKIP LOCKED
    )
    RETURNING id
  `);
}

/**
 * Purge settled outbox rows (PUBLISHED / FAILED), for terminal jobs only.
 *
 * PENDING rows are never deleted. A PUBLISHED row of a job that is still
 * QUEUED / RETRY_SCHEDULED / PROCESSING is the evidence the stale-delivery scan
 * needs to republish a job whose Redis entry was lost, so it is retained until
 * the job is terminal.
 */
export async function cleanupBoundedJobDeliveries(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM job_deliveries
    WHERE id IN (
      SELECT d.id
      FROM job_deliveries AS d
      WHERE d.status IN ('PUBLISHED', 'FAILED')
        AND COALESCE(d.published_at, d.claimed_at, d.available_at) <= ${cutoff}
        AND EXISTS (
          SELECT 1 FROM jobs AS j
          WHERE j.id = d.job_id AND j.status IN (${TERMINAL_JOB_STATUSES})
        )
      ORDER BY d.available_at, d.id
      LIMIT ${batchSize}
      FOR UPDATE OF d SKIP LOCKED
    )
    RETURNING id
  `);
}

/**
 * Purge stopped or failed worker records older than the cutoff.
 *
 * A worker that owns a PROCESSING / CANCEL_REQUESTED job or an unexpired lease
 * is never purged. Retained history rows only lose their worker reference
 * (foreign keys are ON DELETE SET NULL, migration 0009).
 */
export async function cleanupBoundedWorkers(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM workers
    WHERE id IN (
      SELECT w.id
      FROM workers AS w
      WHERE w.status IN ('STOPPED', 'FAILED')
        AND COALESCE(w.stopped_at, w.last_heartbeat_at) <= ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM jobs AS j
          WHERE j.worker_id = w.id
            AND (
              j.status IN ('PROCESSING', 'CANCEL_REQUESTED')
              OR j.lease_expires_at > clock_timestamp()
            )
        )
      ORDER BY w.last_heartbeat_at, w.id
      LIMIT ${batchSize}
      FOR UPDATE OF w SKIP LOCKED
    )
    RETURNING id
  `);
}

/**
 * Purge idempotency keys that expired before the cutoff.
 */
export async function cleanupBoundedIdempotencyKeys(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM idempotency_keys
    WHERE id IN (
      SELECT k.id
      FROM idempotency_keys AS k
      WHERE k.expires_at <= ${cutoff}
      ORDER BY k.expires_at, k.id
      LIMIT ${batchSize}
      FOR UPDATE OF k SKIP LOCKED
    )
    RETURNING id
  `);
}

/**
 * Purge operational audit records created before the cutoff.
 */
export async function cleanupBoundedAuditLogs(
  cutoffDate: Date,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number> {
  assertBatchSize(batchSize);
  const cutoff = cutoffParam(cutoffDate);

  return deleteBatch(sql`
    DELETE FROM operational_audit_logs
    WHERE id IN (
      SELECT l.id
      FROM operational_audit_logs AS l
      WHERE l.created_at <= ${cutoff}
      ORDER BY l.created_at, l.id
      LIMIT ${batchSize}
      FOR UPDATE OF l SKIP LOCKED
    )
    RETURNING id
  `);
}

export interface DatabaseRetentionSummary {
  deletedJobs: number;
  deletedJobEvents: number;
  deletedJobAttempts: number;
  deletedDeadLetters: number;
  deletedJobDeliveries: number;
  deletedWorkers: number;
  deletedIdempotencyKeys: number;
  deletedAuditLogs: number;
  /** Steps that failed. A failed step never prevents later steps. */
  errors: RetentionStepError[];
}

/**
 * Drain one entity in bounded batches. Failures are recorded, not thrown, so
 * one broken step cannot starve the rest of the run; rows already deleted by
 * the failed step are still counted.
 */
async function runStep(
  step: string,
  cleaner: (cutoff: Date, batchSize: number) => Promise<number>,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
  errors: RetentionStepError[]
): Promise<number> {
  let total = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const count = await cleaner(cutoff, batchSize);
      total += count;
      if (count < batchSize) break;
    }
  } catch (error) {
    errors.push({
      step,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return total;
}

/**
 * Execute a bounded, resumable retention run across the PostgreSQL tables.
 *
 * Step order matters:
 * 1. Dead letters first, which releases the references that protect
 *    DEAD_LETTERED jobs and requeued replacements.
 * 2. History (events, attempts, deliveries) of terminal jobs.
 * 3. Terminal jobs.
 * 4. Workers (after jobs, so fewer references remain).
 * 5. Idempotency keys and audit logs.
 */
export async function runDatabaseRetention(
  policy: RetentionPolicy = {},
  options: RetentionBatchOptions = {}
): Promise<DatabaseRetentionSummary> {
  const now = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  assertBatchSize(batchSize);
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new RangeError('Retention max batches must be a positive integer');
  }

  const days = (value: number | undefined, fallback: number): Date =>
    new Date(now - (value ?? fallback) * 86_400_000);
  const hours = (value: number | undefined, fallback: number): Date =>
    new Date(now - (value ?? fallback) * 3_600_000);

  const errors: RetentionStepError[] = [];
  const step = (
    name: string,
    cleaner: (cutoff: Date, batchSize: number) => Promise<number>,
    cutoff: Date
  ): Promise<number> =>
    runStep(name, cleaner, cutoff, batchSize, maxBatches, errors);

  const deletedDeadLetters = await step(
    'dead_letter_jobs',
    cleanupBoundedDeadLetters,
    days(policy.deadLettersDays, 30)
  );
  const deletedJobEvents = await step(
    'job_events',
    cleanupBoundedJobEvents,
    days(policy.jobEventsDays, 14)
  );
  const deletedJobAttempts = await step(
    'job_attempts',
    cleanupBoundedJobAttempts,
    days(policy.jobAttemptsDays, 14)
  );
  const deletedJobDeliveries = await step(
    'job_deliveries',
    cleanupBoundedJobDeliveries,
    days(policy.deliveriesDays, 7)
  );
  const deletedJobs = await step(
    'jobs',
    cleanupBoundedJobs,
    days(policy.jobsCompletedDays, 30)
  );
  const deletedWorkers = await step(
    'workers',
    cleanupBoundedWorkers,
    days(policy.workersDays, 7)
  );
  const deletedIdempotencyKeys = await step(
    'idempotency_keys',
    cleanupBoundedIdempotencyKeys,
    hours(policy.idempotencyKeysHours, 24)
  );
  const deletedAuditLogs = await step(
    'operational_audit_logs',
    cleanupBoundedAuditLogs,
    days(policy.auditLogsDays, 90)
  );

  return {
    deletedJobs,
    deletedJobEvents,
    deletedJobAttempts,
    deletedDeadLetters,
    deletedJobDeliveries,
    deletedWorkers,
    deletedIdempotencyKeys,
    deletedAuditLogs,
    errors,
  };
}
