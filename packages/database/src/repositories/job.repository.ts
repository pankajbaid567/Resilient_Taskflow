import { JobStatus } from '@taskflow/types';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import { db } from '../client';
import * as schema from '../schema';
import { Job, jobs, NewJob } from '../schema';
import { InvalidStateTransitionError } from '../state-machine';

import { insertPendingDelivery } from './dispatch.repository';

/**
 * Job Repository
 *
 * Handles all database operations for jobs.
 */

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface JobWithQueue {
  job: Job;
  queueName: string;
}

export interface PaginatedJobsWithQueue {
  jobs: JobWithQueue[];
  total: number;
}

export type IdempotentJobCreationResult = JobWithQueue & {
  disposition: 'created' | 'replayed';
};

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Idempotency key was already used for a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class ManualRetryConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ManualRetryConflictError';
  }
}

async function resolveQueueName(
  tx: DatabaseTransaction,
  queueId: string
): Promise<string> {
  const [queue] = await tx
    .select({ name: schema.queues.name })
    .from(schema.queues)
    .where(eq(schema.queues.id, queueId))
    .limit(1);

  if (!queue) {
    throw new Error(
      `Queue ${queueId} not found while creating delivery intent`
    );
  }

  return queue.name;
}

async function createJobInTransaction(
  tx: DatabaseTransaction,
  data: NewJob
): Promise<JobWithQueue> {
  const isDue = data.scheduledAt ? data.scheduledAt <= new Date() : true;
  const queueName = await resolveQueueName(tx, data.queueId);
  const [job] = await tx
    .insert(jobs)
    .values({ ...data, status: JobStatus.CREATED, eventSequence: 1 })
    .returning();

  if (!job) {
    throw new Error('Failed to create job');
  }

  await tx.insert(schema.jobEvents).values({
    jobId: job.id,
    eventType: 'created',
    sequence: job.eventSequence,
    fromStatus: null,
    toStatus: JobStatus.CREATED,
    userId: job.userId,
    createdAt: sql`clock_timestamp()`,
    metadata: { version: job.version },
  });

  if (!isDue) {
    return { job, queueName };
  }

  const [queuedJob] = await tx
    .update(jobs)
    .set({
      status: JobStatus.QUEUED,
      version: sql`${jobs.version} + 1`,
      eventSequence: sql`${jobs.eventSequence} + 1`,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, JobStatus.CREATED),
        eq(jobs.version, job.version)
      )
    )
    .returning();

  if (!queuedJob) {
    throw new Error(`Failed to queue newly created job ${job.id}`);
  }

  await insertPendingDelivery(tx, queuedJob.id, queueName, 1);
  await tx.insert(schema.jobEvents).values({
    jobId: queuedJob.id,
    eventType: 'queued',
    sequence: queuedJob.eventSequence,
    fromStatus: JobStatus.CREATED,
    toStatus: JobStatus.QUEUED,
    userId: queuedJob.userId,
    createdAt: sql`clock_timestamp()`,
    metadata: { version: queuedJob.version, source: 'atomic_create' },
  });

  return { job: queuedJob, queueName };
}

/**
 * Create a new job
 */
export async function createJob(data: NewJob): Promise<Job> {
  const result = await db.transaction((tx) => createJobInTransaction(tx, data));
  return result.job;
}

/**
 * Get job by ID
 */
export async function getJobById(jobId: string): Promise<Job | undefined> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  return job;
}

/** Resolve a job only inside its tenant boundary, including its real queue. */
export async function getJobForUser(
  jobId: string,
  userId: string
): Promise<JobWithQueue | undefined> {
  const [result] = await db
    .select({ job: jobs, queueName: schema.queues.name })
    .from(jobs)
    .innerJoin(schema.queues, eq(schema.queues.id, jobs.queueId))
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .limit(1);

  return result;
}

/**
 * Create one new job from an owned dead-lettered job. The original remains
 * immutable; the dead-letter marker, replacement job, lifecycle events, and
 * delivery intent commit atomically.
 */
export async function retryDeadLetteredJobForUser(
  jobId: string,
  userId: string
): Promise<JobWithQueue | undefined> {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select({
        original: jobs,
        deadLetter: schema.deadLetterJobs,
        queue: schema.queues,
      })
      .from(jobs)
      .innerJoin(
        schema.deadLetterJobs,
        eq(schema.deadLetterJobs.originalJobId, jobs.id)
      )
      .innerJoin(schema.queues, eq(schema.queues.id, jobs.queueId))
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
      .limit(1)
      .for('update');

    if (!record) return undefined;
    if (record.original.status !== JobStatus.DEAD_LETTERED) {
      throw new ManualRetryConflictError(
        `Job ${jobId} is not in DEAD_LETTERED state`
      );
    }
    if (record.deadLetter.requeued) {
      throw new ManualRetryConflictError(
        `Job ${jobId} has already been manually retried`
      );
    }
    if (!record.queue.isActive) {
      throw new ManualRetryConflictError(
        `Queue ${record.queue.name} is paused`
      );
    }

    const originalMetadata =
      record.original.metadata !== null &&
      typeof record.original.metadata === 'object' &&
      !Array.isArray(record.original.metadata)
        ? record.original.metadata
        : {};
    const replacement = await createJobInTransaction(tx, {
      userId,
      queueId: record.original.queueId,
      type: record.original.type,
      payload: record.original.payload,
      priority: record.original.priority,
      maxAttempts: record.original.maxAttempts,
      timeoutMs: record.original.timeoutMs,
      scheduledAt: new Date(),
      metadata: {
        ...originalMetadata,
        manuallyRetriedFromJobId: record.original.id,
      },
      tags: record.original.tags,
    });

    const updated = await tx
      .update(schema.deadLetterJobs)
      .set({
        requeued: true,
        requeuedAt: sql`clock_timestamp()`,
        requeuedJobId: replacement.job.id,
      })
      .where(
        and(
          eq(schema.deadLetterJobs.id, record.deadLetter.id),
          eq(schema.deadLetterJobs.requeued, false)
        )
      )
      .returning({ id: schema.deadLetterJobs.id });
    if (updated.length !== 1) {
      throw new ManualRetryConflictError(
        `Job ${jobId} was retried concurrently`
      );
    }

    return replacement;
  });
}

/** Tenant-scoped listing and count from one database snapshot. */
export async function getJobsForUser(
  userId: string,
  options: {
    limit: number;
    offset: number;
    status?: JobStatus;
  }
): Promise<PaginatedJobsWithQueue> {
  const conditions = [eq(jobs.userId, userId)];
  if (options.status) conditions.push(eq(jobs.status, options.status));

  return db.transaction(async (tx) => {
    const [rows, totals] = await Promise.all([
      tx
        .select({ job: jobs, queueName: schema.queues.name })
        .from(jobs)
        .innerJoin(schema.queues, eq(schema.queues.id, jobs.queueId))
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(options.limit)
        .offset(options.offset),
      tx
        .select({ total: sql<number>`COUNT(*)::integer` })
        .from(jobs)
        .where(and(...conditions)),
    ]);

    return { jobs: rows, total: totals[0]?.total ?? 0 };
  });
}

/**
 * Get jobs by user ID with pagination
 */
export async function getJobsByUserId(
  userId: string,
  options: {
    limit?: number;
    offset?: number;
    status?: JobStatus;
  } = {}
): Promise<Job[]> {
  const { limit = 50, offset = 0, status } = options;

  const conditions = [eq(jobs.userId, userId)];
  if (status) {
    conditions.push(eq(jobs.status, status));
  }

  const query = db
    .select()
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(limit)
    .offset(offset);

  return query;
}

/**
 * Get jobs ready to be queued (status = CREATED, scheduledAt <= now)
 */
export async function getJobsReadyToQueue(limit: number = 100): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.status, JobStatus.CREATED), lt(jobs.scheduledAt, new Date()))
    )
    .limit(limit);
}

/**
 * Atomically promote a CREATED job to QUEUED and insert a PENDING delivery
 * row so the Dispatcher will publish it to Redis.
 *
 * This is the only delayed-job promotion mutation. The scheduler calls it
 * when a job's scheduledAt becomes due.
 */
export async function promoteJobToQueued(jobId: string): Promise<Job> {
  return db.transaction(async (tx) => {
    const [lockedJob] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.CREATED),
          sql`${jobs.scheduledAt} <= clock_timestamp()`
        )
      )
      .limit(1)
      .for('update');

    if (!lockedJob) {
      throw new Error(
        `Job ${jobId} cannot be promoted: not found, not CREATED, or not yet due`
      );
    }

    const queueName = await resolveQueueName(tx, lockedJob.queueId);

    const [promoted] = await tx
      .update(jobs)
      .set({
        status: JobStatus.QUEUED,
        version: sql`${jobs.version} + 1`,
        eventSequence: sql`${jobs.eventSequence} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, lockedJob.status),
          eq(jobs.version, lockedJob.version)
        )
      )
      .returning();

    if (!promoted) {
      throw new Error(
        `Concurrent modification prevented promotion of job ${jobId}`
      );
    }

    await tx.insert(schema.jobEvents).values({
      jobId,
      eventType: 'queued',
      sequence: promoted.eventSequence,
      fromStatus: JobStatus.CREATED,
      toStatus: JobStatus.QUEUED,
      userId: promoted.userId,
      createdAt: sql`clock_timestamp()`,
      metadata: { version: promoted.version, source: 'scheduler' },
    });

    // Create delivery row in the same transaction so QUEUED ↔ PENDING are atomic
    await insertPendingDelivery(tx, jobId, queueName, 1);

    return promoted;
  });
}

/**
 * Get jobs ready to process (status = QUEUED, scheduledAt <= now)
 */
export async function getJobsReadyToProcess(
  queueId: string,
  limit: number = 100
): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.queueId, queueId),
        eq(jobs.status, JobStatus.QUEUED),
        lt(jobs.scheduledAt, new Date())
      )
    )
    .orderBy(
      sql`CASE ${jobs.priority}
        WHEN 'CRITICAL' THEN 4
        WHEN 'HIGH' THEN 3
        WHEN 'NORMAL' THEN 2
        WHEN 'LOW' THEN 1
      END DESC`,
      asc(jobs.createdAt)
    )
    .limit(limit);
}

/**
 * Get jobs ready for retry (status = RETRY_SCHEDULED, scheduledAt <= now)
 */
export async function getJobsReadyForRetry(
  limit: number = 100
): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, JobStatus.RETRY_SCHEDULED),
        lt(jobs.scheduledAt, new Date())
      )
    )
    .limit(limit);
}

/**
 * Get jobs with expired leases (status = PROCESSING, leaseExpiresAt < now)
 */
export async function getJobsWithExpiredLeases(
  limit: number = 100
): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, JobStatus.PROCESSING),
        lt(jobs.leaseExpiresAt, new Date())
      )
    )
    .limit(limit);
}

/**
 * Cancel job
 */
export async function cancelJobForUser(
  jobId: string,
  userId: string
): Promise<JobWithQueue | undefined> {
  return db.transaction(async (tx) => {
    // Lock the row to prevent concurrent state mutations
    const [lockedJob] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
      .limit(1)
      .for('update');

    if (!lockedJob) {
      return undefined;
    }

    const cancellableStatuses = [
      JobStatus.CREATED,
      JobStatus.QUEUED,
      JobStatus.RETRY_SCHEDULED,
      JobStatus.PROCESSING,
    ];

    if (!cancellableStatuses.includes(lockedJob.status as JobStatus)) {
      throw new InvalidStateTransitionError(
        `Cannot cancel job in ${lockedJob.status} state`
      );
    }

    // CREATED, QUEUED, and RETRY_SCHEDULED cancel immediately.
    // PROCESSING requires the worker to observe CANCEL_REQUESTED and call
    // completeCancellation — which then sets the final CANCELLED state.
    const nextStatus =
      lockedJob.status === JobStatus.PROCESSING
        ? JobStatus.CANCEL_REQUESTED
        : JobStatus.CANCELLED;

    const isTerminal = nextStatus === JobStatus.CANCELLED;

    const [job] = await tx
      .update(jobs)
      .set({
        status: nextStatus,
        completedAt: isTerminal ? sql`clock_timestamp()` : undefined,
        version: sql`${jobs.version} + 1`,
        eventSequence: sql`${jobs.eventSequence} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, lockedJob.status),
          eq(jobs.version, lockedJob.version)
        )
      )
      .returning();

    if (!job) {
      throw new Error(`Failed to cancel job ${jobId}`);
    }

    await tx.insert(schema.jobEvents).values({
      jobId,
      eventType: isTerminal ? 'cancelled' : 'cancellation_requested',
      sequence: job.eventSequence,
      fromStatus: lockedJob.status,
      toStatus: nextStatus,
      userId: job.userId,
      metadata: {
        version: job.version,
        previousStatus: lockedJob.status,
        immediate: isTerminal,
      },
    });

    const queueName = await resolveQueueName(tx, job.queueId);
    return { job, queueName };
  });
}

/**
 * Get queue statistics
 */
export async function getQueueStats(queueId: string): Promise<
  | {
      queueId: string;
      queued: number;
      processing: number;
      succeeded: number;
      failed: number;
      avgDurationMs: number;
    }
  | undefined
> {
  const [stats] = await db
    .select({
      queueId: jobs.queueId,
      queued: sql<number>`COUNT(*) FILTER (WHERE ${jobs.status} = 'QUEUED')`,
      processing: sql<number>`COUNT(*) FILTER (WHERE ${jobs.status} = 'PROCESSING')`,
      succeeded: sql<number>`COUNT(*) FILTER (WHERE ${jobs.status} = 'SUCCEEDED')`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${jobs.status} = 'FAILED' OR ${jobs.status} = 'DEAD_LETTERED')`,
      avgDurationMs: sql<number>`AVG(EXTRACT(EPOCH FROM (${jobs.completedAt} - ${jobs.startedAt})) * 1000) FILTER (WHERE ${jobs.status} = 'SUCCEEDED')`,
    })
    .from(jobs)
    .where(eq(jobs.queueId, queueId))
    .groupBy(jobs.queueId);

  return stats;
}

/**
 * Count jobs by status
 */
export async function countJobsByStatus(
  userId?: string
): Promise<Record<JobStatus, number>> {
  const query = db
    .select({
      status: jobs.status,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(jobs)
    .groupBy(jobs.status);

  const results = userId
    ? await query.where(eq(jobs.userId, userId))
    : await query;

  // Convert to record with all statuses
  const counts: Record<string, number> = {};
  Object.values(JobStatus).forEach((status) => {
    counts[status] = 0;
  });

  results.forEach((r) => {
    counts[r.status] = r.count;
  });

  return counts as Record<JobStatus, number>;
}

/**
 * Delete old completed jobs (cleanup)
 */
export async function deleteOldCompletedJobs(
  olderThanDays: number = 30
): Promise<number> {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const result = await db
    .delete(jobs)
    .where(
      and(
        inArray(jobs.status, ['SUCCEEDED', 'CANCELLED']),
        lt(jobs.completedAt, cutoffDate)
      )
    );

  return result.length;
}

/** Count all jobs by the shared, canonical database state names. */
export async function getJobCounts(): Promise<Record<JobStatus, number>> {
  return countJobsByStatus();
}

/**
 * Create or replay a job under a per-user idempotency key.
 *
 * The transaction-scoped advisory lock serializes the read/delete/insert
 * sequence even when no key row exists yet. PostgreSQL's unique constraint is
 * the final integrity backstop. Expired keys are deleted under the same lock,
 * so their value can be reused without racing another submitter.
 */
export async function createJobWithIdempotency(
  jobData: NewJob,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  idempotencyExpirationMs: number = 86400000 // 24 hours
): Promise<IdempotentJobCreationResult> {
  if (jobData.userId !== userId) {
    throw new Error('Idempotency owner must match the job owner');
  }
  if (idempotencyKey.length < 1 || idempotencyKey.length > 255) {
    throw new RangeError('Idempotency key must contain 1-255 characters');
  }
  if (!/^[a-f0-9]{64}$/.test(requestHash)) {
    throw new RangeError('Request hash must be a SHA-256 hexadecimal digest');
  }
  if (
    !Number.isInteger(idempotencyExpirationMs) ||
    idempotencyExpirationMs < 1
  ) {
    throw new RangeError('Idempotency expiration must be a positive integer');
  }

  return db.transaction(async (tx) => {
    const lockIdentity = JSON.stringify([userId, idempotencyKey]);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`
    );

    const [existingKey] = await tx
      .select({
        record: schema.idempotencyKeys,
        isActive: sql<boolean>`${schema.idempotencyKeys.expiresAt} > clock_timestamp()`,
      })
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.userId, userId),
          eq(schema.idempotencyKeys.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1)
      .for('update');

    if (existingKey?.isActive) {
      if (existingKey.record.requestHash !== requestHash) {
        throw new IdempotencyConflictError();
      }

      const [existing] = await tx
        .select({ job: jobs, queueName: schema.queues.name })
        .from(jobs)
        .innerJoin(schema.queues, eq(schema.queues.id, jobs.queueId))
        .where(eq(jobs.id, existingKey.record.jobId))
        .limit(1);

      if (!existing) {
        throw new Error('Idempotency key exists but job not found');
      }

      return { ...existing, disposition: 'replayed' as const };
    }

    if (existingKey) {
      await tx
        .delete(schema.idempotencyKeys)
        .where(eq(schema.idempotencyKeys.id, existingKey.record.id));
    }

    const created = await createJobInTransaction(tx, jobData);
    const expiresAt = new Date(Date.now() + idempotencyExpirationMs);
    await tx.insert(schema.idempotencyKeys).values({
      id: crypto.randomUUID(),
      userId,
      idempotencyKey,
      jobId: created.job.id,
      requestHash,
      expiresAt,
    });

    return { ...created, disposition: 'created' as const };
  });
}

/**
 * Clean up expired idempotency keys
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await db
    .delete(schema.idempotencyKeys)
    .where(sql`${schema.idempotencyKeys.expiresAt} <= clock_timestamp()`);

  return result.length;
}
