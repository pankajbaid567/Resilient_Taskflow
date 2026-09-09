import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';

import { JobStatus } from '@taskflow/types';

import { db } from '../client';
import * as schema from '../schema';
import { Job, jobs, NewJob } from '../schema';
import {
  InvalidStateTransitionError,
  validateTransition,
} from '../state-machine';

/**
 * Job Repository
 *
 * Handles all database operations for jobs.
 */

/**
 * Create a new job
 */
export async function createJob(data: NewJob): Promise<Job> {
  return db.transaction(async (tx) => {
    const [job] = await tx.insert(jobs).values(data).returning();

    if (!job) {
      throw new Error('Failed to create job');
    }

    await tx.insert(schema.jobEvents).values({
      jobId: job.id,
      eventType: 'created',
      fromStatus: null,
      toStatus: job.status,
      userId: job.userId,
      metadata: { version: job.version },
    });

    return job;
  });
}

/**
 * Get job by ID
 */
export async function getJobById(jobId: string): Promise<Job | undefined> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  return job;
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
    .where(and(eq(jobs.status, 'CREATED'), lt(jobs.scheduledAt, new Date())))
    .limit(limit);
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
        eq(jobs.status, 'QUEUED'),
        lt(jobs.scheduledAt, new Date())
      )
    )
    .orderBy(desc(jobs.priority), asc(jobs.createdAt))
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
      and(eq(jobs.status, 'RETRY_SCHEDULED'), lt(jobs.scheduledAt, new Date()))
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
      and(eq(jobs.status, 'PROCESSING'), lt(jobs.leaseExpiresAt, new Date()))
    )
    .limit(limit);
}

/**
 * Update job status with state machine validation
 */
export async function updateJobStatus(
  jobId: string,
  newStatus: JobStatus,
  updates: Partial<Job> = {}
): Promise<Job> {
  return db.transaction(async (tx) => {
    const [currentJob] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
      .for('update');

    if (!currentJob) {
      throw new Error(`Job ${jobId} not found`);
    }

    validateTransition(currentJob.status as JobStatus, newStatus);

    const [updatedJob] = await tx
      .update(jobs)
      .set({
        ...updates,
        status: newStatus,
        version: sql`${jobs.version} + 1`,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.version, currentJob.version)))
      .returning();

    if (!updatedJob) {
      throw new Error(
        `Failed to update job ${jobId}. Concurrent modification detected.`
      );
    }

    await tx.insert(schema.jobEvents).values({
      jobId,
      eventType: eventTypeForStatus(newStatus),
      fromStatus: currentJob.status,
      toStatus: newStatus,
      workerId: updatedJob.workerId,
      userId: updatedJob.userId,
      metadata: { version: updatedJob.version },
    });

    return updatedJob;
  });
}

/**
 * Acquire job lease (for worker to process)
 *
 * Uses optimistic locking to ensure only one worker can acquire lease.
 */
export async function acquireJobLease(
  jobId: string,
  workerId: string,
  leaseDurationMs: number = 30000
): Promise<Job | null> {
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

  const [job] = await db
    .update(jobs)
    .set({
      status: 'PROCESSING',
      workerId,
      leaseId,
      leaseExpiresAt,
      startedAt: sql`COALESCE(${jobs.startedAt}, NOW())`,
      attempts: sql`${jobs.attempts} + 1`,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, 'QUEUED'),
        lt(jobs.scheduledAt, new Date()),
        or(
          sql`${jobs.leaseExpiresAt} IS NULL`,
          lt(jobs.leaseExpiresAt, new Date())
        )
      )
    )
    .returning();

  return job || null;
}

/**
 * Renew job lease (worker extends lease)
 */
export async function renewJobLease(
  jobId: string,
  workerId: string,
  leaseId: string,
  leaseDurationMs: number = 30000
): Promise<Job | null> {
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

  const [job] = await db
    .update(jobs)
    .set({
      leaseExpiresAt,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workerId, workerId),
        eq(jobs.leaseId, leaseId),
        eq(jobs.status, 'PROCESSING')
      )
    )
    .returning();

  return job || null;
}

/**
 * Release job lease (worker releases without completion)
 */
export async function releaseJobLease(
  jobId: string,
  workerId: string,
  leaseId: string
): Promise<Job | null> {
  const [job] = await db
    .update(jobs)
    .set({
      status: 'QUEUED',
      workerId: null,
      leaseId: null,
      leaseExpiresAt: null,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workerId, workerId),
        eq(jobs.leaseId, leaseId)
      )
    )
    .returning();

  return job || null;
}

/**
 * Complete job successfully
 */
export async function completeJob(
  jobId: string,
  workerId: string,
  result: Record<string, unknown>
): Promise<Job> {
  const [job] = await db
    .update(jobs)
    .set({
      status: 'SUCCEEDED',
      result,
      completedAt: new Date(),
      leaseId: null,
      leaseExpiresAt: null,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workerId, workerId),
        eq(jobs.status, 'PROCESSING')
      )
    )
    .returning();

  if (!job) {
    throw new Error(`Failed to complete job ${jobId}`);
  }

  return job;
}

/**
 * Fail job with optional retry scheduling
 */
export async function failJob(
  jobId: string,
  workerId: string,
  error: Record<string, unknown>,
  options: {
    shouldRetry: boolean;
    retryDelayMs?: number;
  }
): Promise<Job> {
  const { shouldRetry, retryDelayMs = 0 } = options;

  const currentJob = await getJobById(jobId);
  if (!currentJob) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Determine next status
  let nextStatus: JobStatus;
  let scheduledAt = currentJob.scheduledAt;

  if (shouldRetry && currentJob.attempts < currentJob.maxAttempts) {
    nextStatus = JobStatus.RETRY_SCHEDULED;
    scheduledAt = new Date(Date.now() + retryDelayMs);
  } else {
    nextStatus = JobStatus.DEAD_LETTERED;
  }

  const [job] = await db
    .update(jobs)
    .set({
      status: nextStatus,
      error,
      failedAt: new Date(),
      scheduledAt,
      leaseId: null,
      leaseExpiresAt: null,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workerId, workerId),
        eq(jobs.status, 'PROCESSING')
      )
    )
    .returning();

  if (!job) {
    throw new Error(`Failed to fail job ${jobId}`);
  }

  return job;
}

/**
 * Cancel job
 */
export async function cancelJob(jobId: string): Promise<Job> {
  const currentJob = await getJobById(jobId);

  if (!currentJob) {
    throw new Error(`Job ${jobId} not found`);
  }

  let nextStatus: JobStatus;

  if (currentJob.status === 'PROCESSING') {
    // Request cancellation for running job
    nextStatus = JobStatus.CANCEL_REQUESTED;
  } else if (
    currentJob.status === 'QUEUED' ||
    currentJob.status === 'RETRY_SCHEDULED'
  ) {
    // Immediately cancel queued job
    nextStatus = JobStatus.CANCELLED;
  } else {
    throw new InvalidStateTransitionError(
      `Cannot cancel job in ${currentJob.status} state`
    );
  }

  const [job] = await db
    .update(jobs)
    .set({
      status: nextStatus,
      completedAt: nextStatus === 'CANCELLED' ? new Date() : undefined,
      version: sql`${jobs.version} + 1`,
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.version, currentJob.version)))
    .returning();

  if (!job) {
    throw new Error(`Failed to cancel job ${jobId}`);
  }

  return job;
}

/**
 * Get queue statistics
 */
export async function getQueueStats(queueId: string) {
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

  if (userId) {
    query.where(eq(jobs.userId, userId));
  }

  const results = await query;

  // Convert to record with all statuses
  const counts: Record<string, number> = {};
  Object.values(JobStatus).forEach((status) => {
    counts[status] = 0;
  });

  results.forEach((r) => {
    if (r.status) {
      counts[r.status] = r.count;
    }
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

/**
 * Get job counts by status
 */
export async function getJobCounts(): Promise<{
  created: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  dead_lettered: number;
}> {
  const results = await db
    .select({
      status: jobs.status,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(jobs)
    .groupBy(jobs.status);

  const counts = {
    created: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    dead_lettered: 0,
  };

  for (const row of results) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.count;
    }
  }

  return counts;
}

/**
 * Get queue statistics by name
 */
export async function getQueueStatsByName(_queueName: string): Promise<{
  created: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  dead_lettered: number;
}> {
  // TODO: Join with queues table to filter by queue name
  // For now, return all jobs
  return getJobCounts();
}

/**
 * Schedule job for retry
 */
export async function scheduleJobRetry(
  jobId: string,
  scheduledAt: Date,
  error?: {
    error: string;
    stackTrace?: string;
  }
): Promise<Job> {
  const [job] = await db
    .update(jobs)
    .set({
      status: 'RETRY_SCHEDULED',
      scheduledAt,
      error: error ? { message: error.error, stack: error.stackTrace } : null,
    })
    .where(eq(jobs.id, jobId))
    .returning();

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  return job;
}

/**
 * Move job to dead letter queue
 */
export async function moveJobToDeadLetter(
  jobId: string,
  reason: string
): Promise<void> {
  const job = await getJobById(jobId);

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Update job status to DEAD_LETTERED
  await db
    .update(jobs)
    .set({
      status: 'DEAD_LETTERED',
      failedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));

  // Insert into dead_letter_jobs table
  await db.insert(schema.deadLetterJobs).values({
    id: crypto.randomUUID(),
    originalJobId: job.id,
    userId: job.userId,
    queueId: job.queueId,
    type: job.type,
    payload: job.payload,
    attempts: job.attempts,
    lastError: job.error,
    lastErrorMessage:
      typeof job.error === 'string' ? job.error : JSON.stringify(job.error),
    createdAt: job.createdAt,
    failedAt: job.failedAt || new Date(),
    requeued: false,
    requeuedAt: null,
    requeuedJobId: null,
    metadata: job.metadata
      ? {
          ...(job.metadata as Record<string, unknown>),
          deadLetterReason: reason,
          deadLetteredAt: new Date().toISOString(),
        }
      : {
          deadLetterReason: reason,
          deadLetteredAt: new Date().toISOString(),
        },
  });
}

/**
 * Check if idempotency key exists and return existing job
 */
export async function getJobByIdempotencyKey(
  userId: string,
  idempotencyKey: string
): Promise<Job | undefined> {
  // Find idempotency key
  const [idempotencyRecord] = await db
    .select()
    .from(schema.idempotencyKeys)
    .where(
      and(
        eq(schema.idempotencyKeys.userId, userId),
        eq(schema.idempotencyKeys.idempotencyKey, idempotencyKey),
        gt(schema.idempotencyKeys.expiresAt, new Date()) // Not expired
      )
    );

  if (!idempotencyRecord) {
    return undefined;
  }

  // Return associated job
  return getJobById(idempotencyRecord.jobId);
}

/**
 * Create idempotency key record
 */
export async function createIdempotencyKey(
  userId: string,
  idempotencyKey: string,
  jobId: string,
  requestHash: string,
  expiresAt: Date
): Promise<void> {
  await db.insert(schema.idempotencyKeys).values({
    id: crypto.randomUUID(),
    userId,
    idempotencyKey,
    jobId,
    requestHash,
    createdAt: new Date(),
    expiresAt,
  });
}

/**
 * Create job with idempotency key in a transaction
 */
export async function createJobWithIdempotency(
  jobData: NewJob,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  idempotencyExpirationMs: number = 86400000 // 24 hours
): Promise<Job> {
  return await db.transaction(async (tx) => {
    // Check if idempotency key already exists
    const [existingKey] = await tx
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.userId, userId),
          eq(schema.idempotencyKeys.idempotencyKey, idempotencyKey),
          gt(schema.idempotencyKeys.expiresAt, new Date())
        )
      );

    if (existingKey) {
      // Return existing job
      const [existingJob] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, existingKey.jobId));

      if (!existingJob) {
        throw new Error('Idempotency key exists but job not found');
      }

      return existingJob;
    }

    // Create new job
    const [job] = await tx.insert(jobs).values(jobData).returning();

    if (!job) {
      throw new Error('Failed to create job');
    }

    await tx.insert(schema.jobEvents).values({
      jobId: job.id,
      eventType: 'created',
      fromStatus: null,
      toStatus: job.status,
      userId: job.userId,
      metadata: { version: job.version },
    });

    // Create idempotency key
    const expiresAt = new Date(Date.now() + idempotencyExpirationMs);
    await tx.insert(schema.idempotencyKeys).values({
      id: crypto.randomUUID(),
      userId,
      idempotencyKey,
      jobId: job.id,
      requestHash,
      createdAt: new Date(),
      expiresAt,
    });

    return job;
  });
}

/**
 * Clean up expired idempotency keys
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await db
    .delete(schema.idempotencyKeys)
    .where(lt(schema.idempotencyKeys.expiresAt, new Date()));

  return result.length;
}

function eventTypeForStatus(status: JobStatus): string {
  switch (status) {
    case JobStatus.CREATED:
      return 'created';
    case JobStatus.QUEUED:
      return 'queued';
    case JobStatus.PROCESSING:
      return 'started';
    case JobStatus.SUCCEEDED:
      return 'completed';
    case JobStatus.FAILED:
      return 'failed';
    case JobStatus.RETRY_SCHEDULED:
      return 'retried';
    case JobStatus.CANCEL_REQUESTED:
    case JobStatus.CANCELLED:
      return 'cancelled';
    case JobStatus.DEAD_LETTERED:
      return 'dead_lettered';
  }
}
