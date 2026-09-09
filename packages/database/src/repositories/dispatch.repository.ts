import { JobStatus } from '@taskflow/types';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

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

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[keyof typeof DELIVERY_STATUSES];

/**
 * Insert a PENDING delivery row in the same transaction that creates or
 * promotes a job to QUEUED. The caller is responsible for the surrounding
 * transaction.
 *
 * @param tx  - Active Drizzle transaction
 * @param jobId - The job being queued
 * @param queueName - Canonical queue name (from queues table, not JSON metadata)
 * @param attempt - Attempt number to encode in the Redis envelope (default: 1)
 */
export async function insertPendingDelivery(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  jobId: string,
  queueName: string,
  attempt: number = 1
): Promise<JobDelivery> {
  const [delivery] = await tx
    .insert(jobDeliveries)
    .values({
      jobId,
      queueName,
      attempt,
      status: DELIVERY_STATUSES.PENDING,
    })
    .onConflictDoNothing({ target: [jobDeliveries.jobId, jobDeliveries.attempt] })
    .returning();

  if (!delivery) {
    // Row already exists (idempotent re-attempt) — fetch it
    const [existing] = await tx
      .select()
      .from(jobDeliveries)
      .where(
        and(
          eq(jobDeliveries.jobId, jobId),
          eq(jobDeliveries.attempt, attempt)
        )
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
 * Uses FOR UPDATE SKIP LOCKED so multiple Dispatcher instances never
 * process the same row simultaneously. Returns rows ordered oldest-first.
 */
export async function claimPendingDeliveries(
  dispatcherId: string,
  limit: number = 50
): Promise<JobDelivery[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(jobDeliveries)
      .where(eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING))
      .orderBy(jobDeliveries.createdAt)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    await tx
      .update(jobDeliveries)
      .set({
        claimedBy: dispatcherId,
        claimedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          sql`${jobDeliveries.id} = ANY(${sql.raw(`'{${ids.join(',')}}'::uuid[]`)})`,
          eq(jobDeliveries.status, DELIVERY_STATUSES.PENDING)
        )
      );

    return rows;
  });
}

/**
 * Record a successful Redis XADD. Caller should call this after
 * confirming the XADD returned a message ID.
 */
export async function markDeliveryPublished(
  deliveryId: string,
  redisMessageId: string
): Promise<void> {
  await db
    .update(jobDeliveries)
    .set({
      status: DELIVERY_STATUSES.PUBLISHED,
      redisMessageId,
      publishedAt: sql`clock_timestamp()`,
      claimedBy: null,
      claimedAt: null,
    })
    .where(eq(jobDeliveries.id, deliveryId));
}

/**
 * Record a permanent dispatch failure after all retries are exhausted.
 * The job remains QUEUED — a human operator must inspect.
 */
export async function markDeliveryFailed(
  deliveryId: string,
  error: string,
  retryCount: number
): Promise<void> {
  await db
    .update(jobDeliveries)
    .set({
      status: DELIVERY_STATUSES.FAILED,
      error,
      retryCount,
      claimedBy: null,
      claimedAt: null,
    })
    .where(eq(jobDeliveries.id, deliveryId));
}

/**
 * Increment retry count and release the claim so another dispatcher
 * cycle will pick it up.
 */
export async function releaseDeliveryForRetry(
  deliveryId: string,
  error: string,
  retryCount: number
): Promise<void> {
  await db
    .update(jobDeliveries)
    .set({
      retryCount,
      error,
      claimedBy: null,
      claimedAt: null,
    })
    .where(eq(jobDeliveries.id, deliveryId));
}

/**
 * Find PUBLISHED delivery rows whose job is still in a non-terminal,
 * non-processing state (QUEUED or RETRY_SCHEDULED with scheduledAt <=
 * now). These are candidates for republication when stream entries may
 * have been lost (e.g., Redis restart without persistence).
 *
 * The caller compares the job status against its delivery to decide
 * whether to republish.
 */
export async function getStaleDeliveries(
  olderThanMs: number = 60_000,
  limit: number = 50
): Promise<Array<{ delivery: JobDelivery; queueName: string; attempt: number }>> {
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
            sql`${jobs.scheduledAt} <= clock_timestamp()`
          ),
          // Retry is due but delivery was never picked up
          and(
            eq(jobs.status, JobStatus.RETRY_SCHEDULED),
            sql`${jobs.scheduledAt} <= clock_timestamp()`
          )
        ),
        // Unclaimed or claim is stale
        or(isNull(jobDeliveries.claimedBy), lt(jobDeliveries.claimedAt, cutoff))
      )
    )
    .limit(limit);

  return rows;
}

/**
 * Reset a PUBLISHED delivery row back to PENDING so the dispatcher
 * will republish it. Used by the stale-delivery scan.
 */
export async function resetDeliveryToPending(deliveryId: string): Promise<void> {
  await db
    .update(jobDeliveries)
    .set({
      status: DELIVERY_STATUSES.PENDING,
      redisMessageId: null,
      publishedAt: null,
      claimedBy: null,
      claimedAt: null,
    })
    .where(eq(jobDeliveries.id, deliveryId));
}
