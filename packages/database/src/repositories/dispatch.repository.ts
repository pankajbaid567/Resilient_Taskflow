import { JobStatus } from '@taskflow/types';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { db } from '../client';
import { jobDeliveries, jobs } from '../schema';
import type { JobDelivery } from '../schema';

/**
 * Dispatch Repository
 *
 * Manages the job_deliveries outbox table used by the Dispatcher to
 * guarantee durable at-least-once XADD delivery.
 */

const DELIVERY_STATUSES = {
  PENDING: 'PENDING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
} as const;

export type DeliveryStatus =
  (typeof DELIVERY_STATUSES)[keyof typeof DELIVERY_STATUSES];

export interface StaleDeliveryCursor {
  deliveryId: string;
}

/**
 * Insert a PENDING delivery row in the same transaction that creates or
 * promotes a job to QUEUED. The caller is responsible for the surrounding
 * transaction.
 *
 * @param tx  - Active Drizzle transaction
 * @param jobId - The job being queued
 * @param queueName - Canonical queue name (from queues table, not JSON metadata)
 * @param attempt - Producer-supplied delivery hint (default: 1). PostgreSQL
 * jobs.attempts remains authoritative for execution/retry decisions.
 * @param availableAt - Durable time at which a dispatcher may claim the row.
 */
export async function insertPendingDelivery(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  jobId: string,
  queueName: string,
  attempt: number = 1,
  availableAt?: Date | SQL
): Promise<JobDelivery> {
  const [delivery] = await tx
    .insert(jobDeliveries)
    .values({
      jobId,
      queueName,
      attempt,
      availableAt,
      status: DELIVERY_STATUSES.PENDING,
    })
    .onConflictDoNothing({
      target: [jobDeliveries.jobId, jobDeliveries.attempt],
    })
    .returning();

  if (!delivery) {
    // Row already exists (idempotent re-attempt) — fetch it
    const [existing] = await tx
      .select()
      .from(jobDeliveries)
      .where(
        and(eq(jobDeliveries.jobId, jobId), eq(jobDeliveries.attempt, attempt))
      )
      .limit(1);

    if (!existing) {
      throw new Error(`Failed to insert or find delivery row for job ${jobId}`);
    }

    return existing;
  }

  return delivery;
}

/**
 * Claim up to `limit` PENDING delivery rows for exclusive processing.
 *
 * Uses FOR UPDATE SKIP LOCKED and a persisted claim lease so multiple live
 * Dispatcher instances do not process the same row simultaneously. Claims
 * abandoned by a crashed dispatcher become eligible after `claimTimeoutMs`.
 * Returns due rows ordered by durable availability, then creation time.
 */
export async function claimPendingDeliveries(
  dispatcherId: string,
  limit: number = 50,
  claimTimeoutMs: number = 30_000
): Promise<JobDelivery[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Delivery claim limit must be a positive integer');
  }
  if (!Number.isFinite(claimTimeoutMs) || claimTimeoutMs < 1) {
    throw new Error('Delivery claim timeout must be positive');
  }

  return db.transaction(async (tx) => {
    const claimable = or(
      isNull(jobDeliveries.claimedBy),
      isNull(jobDeliveries.claimedAt),
      sql`${jobDeliveries.claimedAt} < clock_timestamp() - (${claimTimeoutMs} * interval '1 millisecond')`
    );

    const rows = await tx
      .select()
      .from(jobDeliveries)
      .where(
        and(
          eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING),
          lte(jobDeliveries.availableAt, sql`clock_timestamp()`),
          claimable
        )
      )
      .orderBy(jobDeliveries.availableAt, jobDeliveries.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const claimed = await tx
      .update(jobDeliveries)
      .set({
        claimedBy: dispatcherId,
        claimedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          inArray(jobDeliveries.id, ids),
          eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING),
          lte(jobDeliveries.availableAt, sql`clock_timestamp()`),
          claimable
        )
      )
      .returning();

    // UPDATE ... RETURNING has no ordering guarantee. Preserve the oldest-first
    // order selected under FOR UPDATE so dispatcher behavior is deterministic.
    const claimedById = new Map(claimed.map((row) => [row.id, row]));
    return rows.flatMap((row) => {
      const updated = claimedById.get(row.id);
      return updated ? [updated] : [];
    });
  });
}

/**
 * Record a successful Redis XADD. Caller should call this after
 * confirming the XADD returned a message ID.
 */
export async function markDeliveryPublished(
  deliveryId: string,
  dispatcherId: string,
  redisMessageId: string
): Promise<boolean> {
  const updated = await db
    .update(jobDeliveries)
    .set({
      status: DELIVERY_STATUSES.PUBLISHED,
      redisMessageId,
      publishedAt: sql`clock_timestamp()`,
      claimedBy: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(jobDeliveries.id, deliveryId),
        eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING),
        eq(jobDeliveries.claimedBy, dispatcherId)
      )
    )
    .returning({ id: jobDeliveries.id });

  return updated.length === 1;
}

/**
 * Refresh an owned PENDING claim immediately before an external Redis call.
 * This prevents rows near the end of a claimed batch from expiring while
 * earlier rows are being published. A false result means another dispatcher
 * already recovered the claim and this owner must not publish it.
 */
export async function renewDeliveryClaim(
  deliveryId: string,
  dispatcherId: string
): Promise<boolean> {
  const updated = await db
    .update(jobDeliveries)
    .set({ claimedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(jobDeliveries.id, deliveryId),
        eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING),
        eq(jobDeliveries.claimedBy, dispatcherId)
      )
    )
    .returning({ id: jobDeliveries.id });

  return updated.length === 1;
}

/**
 * Administrative escape hatch for a non-retryable delivery failure. Ordinary
 * Redis exhaustion must use releaseDeliveryForRetry so a QUEUED job cannot be
 * stranded by a transient infrastructure outage.
 */
export async function markDeliveryFailed(
  deliveryId: string,
  dispatcherId: string,
  error: string,
  retryCount: number
): Promise<boolean> {
  const updated = await db
    .update(jobDeliveries)
    .set({
      status: DELIVERY_STATUSES.FAILED,
      error,
      retryCount,
      claimedBy: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(jobDeliveries.id, deliveryId),
        eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING),
        eq(jobDeliveries.claimedBy, dispatcherId)
      )
    )
    .returning({ id: jobDeliveries.id });

  return updated.length === 1;
}

/**
 * Increment retry count and release the claim so another dispatcher
 * cycle will pick it up.
 */
export async function releaseDeliveryForRetry(
  deliveryId: string,
  dispatcherId: string,
  error: string,
  retryCount: number
): Promise<boolean> {
  const updated = await db
    .update(jobDeliveries)
    .set({
      retryCount,
      error,
      claimedBy: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(jobDeliveries.id, deliveryId),
        eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING),
        eq(jobDeliveries.claimedBy, dispatcherId)
      )
    )
    .returning({ id: jobDeliveries.id });

  return updated.length === 1;
}

/**
 * Find PUBLISHED delivery rows whose job still needs a delivery: due
 * QUEUED/RETRY_SCHEDULED jobs, or PROCESSING/CANCEL_REQUESTED jobs whose
 * database lease has expired. These are candidates for republication when a
 * stream entry or consumer-group state was lost.
 *
 * The caller compares the job status against its delivery to decide
 * whether to republish.
 */
export async function getStaleDeliveries(
  olderThanMs: number = 60_000,
  limit: number = 50,
  after?: StaleDeliveryCursor
): Promise<
  Array<{ delivery: JobDelivery; queueName: string; attempt: number }>
> {
  const cutoff = new Date(Date.now() - olderThanMs);

  const rows = await db
    .select({
      delivery: jobDeliveries,
      queueName: jobDeliveries.queueName,
      attempt: jobDeliveries.attempt,
    })
    .from(jobDeliveries)
    .innerJoin(jobs, eq(jobs.id, jobDeliveries.jobId))
    .where(
      and(
        eq(jobDeliveries.status, DELIVERY_STATUSES.PUBLISHED),
        lt(jobDeliveries.publishedAt, cutoff),
        or(
          // Job is still QUEUED (stream entry may have been lost)
          and(
            eq(jobs.status, JobStatus.QUEUED),
            sql`${jobs.scheduledAt} <= clock_timestamp()`,
            sql`${jobDeliveries.attempt} = ${jobs.attempts} + 1`
          ),
          // Retry is due but delivery was never picked up
          and(
            eq(jobs.status, JobStatus.RETRY_SCHEDULED),
            sql`${jobs.scheduledAt} <= clock_timestamp()`,
            sql`${jobDeliveries.attempt} = ${jobs.attempts} + 1`
          ),
          // A lost Redis entry must not strand a job after its worker dies.
          // Once the database lease expires, republication gives a replacement
          // worker the delivery needed to perform fenced recovery.
          and(
            eq(jobs.status, JobStatus.PROCESSING),
            eq(jobDeliveries.attempt, jobs.attempts),
            or(
              isNull(jobs.leaseExpiresAt),
              lte(jobs.leaseExpiresAt, sql`clock_timestamp()`)
            )
          ),
          and(
            eq(jobs.status, JobStatus.CANCEL_REQUESTED),
            eq(jobDeliveries.attempt, jobs.attempts),
            or(
              isNull(jobs.leaseExpiresAt),
              lte(jobs.leaseExpiresAt, sql`clock_timestamp()`)
            )
          )
        ),
        // Unclaimed or claim is stale
        or(
          isNull(jobDeliveries.claimedBy),
          lt(jobDeliveries.claimedAt, cutoff)
        ),
        after ? gt(jobDeliveries.id, after.deliveryId) : undefined
      )
    )
    // UUID is used as the cursor because it round-trips exactly. JavaScript
    // Date truncates PostgreSQL microseconds and can otherwise repeat a page.
    .orderBy(asc(jobDeliveries.id))
    .limit(limit);

  return rows;
}

/**
 * Reset a PUBLISHED delivery row back to PENDING so the dispatcher
 * will republish it. Used by the stale-delivery scan.
 */
export async function resetDeliveryToPending(
  deliveryId: string
): Promise<boolean> {
  const updated = await db
    .update(jobDeliveries)
    .set({
      status: DELIVERY_STATUSES.PENDING,
      redisMessageId: null,
      publishedAt: null,
      claimedBy: null,
      claimedAt: null,
    })
    .where(
      and(
        eq(jobDeliveries.id, deliveryId),
        eq(jobDeliveries.status, DELIVERY_STATUSES.PUBLISHED)
      )
    )
    .returning({ id: jobDeliveries.id });

  return updated.length === 1;
}
