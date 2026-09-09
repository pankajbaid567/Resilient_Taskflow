import { and, eq, getTableColumns, sql } from 'drizzle-orm';

import { JobStatus } from '@taskflow/types';

import { db } from '../client';
import {
  deadLetterJobs,
  Job,
  JobAttempt,
  jobAttempts,
  jobEvents,
  jobs,
  Queue,
  queues,
} from '../schema';

/**
 * Result of trying to turn a Redis delivery into an owned database lease.
 *
 * Database/transport failures are deliberately not represented here. They are
 * thrown so callers cannot accidentally acknowledge a message after treating
 * an unavailable database as an ordinary contention outcome.
 */
export type JobDeliveryLeaseOutcome =
  | { kind: 'ACQUIRED'; job: Job }
  | { kind: 'TERMINAL'; job: Job }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_READY'; job: Job }
  | { kind: 'BUSY'; job: Job };

export interface JobDeliveryFailureOptions {
  baseDelayMs: number;
  maxDelayMs: number;
}

export type JobDeliveryFailureOutcome =
  | { job: Job; terminal: true }
  | { job: Job; terminal: false; retryDelayMs: number };

/**
 * Raised when a worker attempts to mutate a job with a stale or expired lease.
 */
export class JobDeliveryLeaseLostError extends Error {
  constructor(jobId: string, operation: string) {
    super(
      `Cannot ${operation} job ${jobId}: delivery lease is no longer owned`
    );
    this.name = 'JobDeliveryLeaseLostError';
  }
}

/**
 * Resolve the durable queue row used by API job creation.
 */
export async function getQueueByName(name: string): Promise<Queue | undefined> {
  const [queue] = await db
    .select()
    .from(queues)
    .where(eq(queues.name, name))
    .limit(1);

  return queue;
}

/**
 * Acquire a fenced lease for a Redis-delivered job.
 *
 * The row lock serializes recovery, retry promotion, and acquisition. A due
 * retry is promoted to QUEUED before acquisition. An expired PROCESSING lease
 * is recorded as a failed attempt and either recovered or dead-lettered when
 * the attempt budget has been exhausted.
 */
export async function acquireJobForDelivery(
  jobId: string,
  workerId: string,
  leaseDurationMs: number
): Promise<JobDeliveryLeaseOutcome> {
  assertPositiveDuration(leaseDurationMs, 'leaseDurationMs');

  const leaseId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    const [lockedJob] = await tx
      .select({
        ...getTableColumns(jobs),
        scheduledIsDue: sql<boolean>`${jobs.scheduledAt} <= clock_timestamp()`,
        leaseIsActive: sql<boolean>`COALESCE(${jobs.leaseExpiresAt} > clock_timestamp(), false)`,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
      .for('update');

    if (!lockedJob) {
      return { kind: 'NOT_FOUND' };
    }

    const { scheduledIsDue, leaseIsActive, ...lockedJobColumns } = lockedJob;
    let job: Job = lockedJobColumns;
    const observedAt = new Date();

    if (isTerminalStatus(job.status)) {
      return { kind: 'TERMINAL', job };
    }

    if (job.status === JobStatus.RETRY_SCHEDULED) {
      if (!scheduledIsDue) {
        return { kind: 'NOT_READY', job };
      }

      const [promotedJob] = await tx
        .update(jobs)
        .set({
          status: JobStatus.QUEUED,
          workerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, JobStatus.RETRY_SCHEDULED),
            eq(jobs.version, job.version),
            sql`${jobs.scheduledAt} <= clock_timestamp()`
          )
        )
        .returning();

      if (!promotedJob) {
        throw new Error(`Failed to promote due retry for job ${job.id}`);
      }

      await tx.insert(jobEvents).values({
        jobId: job.id,
        eventType: 'retried',
        fromStatus: JobStatus.RETRY_SCHEDULED,
        toStatus: JobStatus.QUEUED,
        userId: job.userId,
        metadata: {
          reason: 'retry_due',
          scheduledAt: job.scheduledAt.toISOString(),
        },
      });

      job = promotedJob;
    }

    if (job.status === JobStatus.PROCESSING) {
      if (!job.leaseExpiresAt || leaseIsActive) {
        return { kind: 'BUSY', job };
      }

      const leaseExpiredError = {
        code: 'LEASE_EXPIRED',
        message: 'Worker lease expired before the attempt completed',
      };

      if (job.attempts > 0) {
        const durationMs = elapsedMilliseconds(job.startedAt, observedAt);
        const attemptStartedAt = job.startedAt
          ? sql`${job.startedAt.toISOString()}::timestamptz`
          : sql`clock_timestamp()`;

        await tx
          .insert(jobAttempts)
          .values({
            jobId: job.id,
            attemptNumber: job.attempts,
            workerId: job.workerId,
            startedAt: attemptStartedAt,
            completedAt: sql`clock_timestamp()`,
            durationMs,
            status: JobStatus.FAILED,
            error: leaseExpiredError,
            errorMessage: leaseExpiredError.message,
            metadata: {
              reason: 'lease_expired',
              leaseId: job.leaseId,
            },
          })
          .onConflictDoUpdate({
            target: [jobAttempts.jobId, jobAttempts.attemptNumber],
            set: {
              completedAt: sql`clock_timestamp()`,
              durationMs,
              status: JobStatus.FAILED,
              error: leaseExpiredError,
              errorMessage: leaseExpiredError.message,
              metadata: {
                reason: 'lease_expired',
                leaseId: job.leaseId,
              },
            },
          });
      }

      if (job.attempts >= job.maxAttempts) {
        const [deadLetteredJob] = await tx
          .update(jobs)
          .set({
            status: JobStatus.DEAD_LETTERED,
            error: leaseExpiredError,
            failedAt: sql`clock_timestamp()`,
            completedAt: sql`clock_timestamp()`,
            leaseId: null,
            leaseExpiresAt: null,
            version: sql`${jobs.version} + 1`,
          })
          .where(
            and(
              eq(jobs.id, job.id),
              eq(jobs.status, JobStatus.PROCESSING),
              eq(jobs.version, job.version)
            )
          )
          .returning();

        if (!deadLetteredJob) {
          throw new Error(`Failed to dead-letter expired job ${job.id}`);
        }

        await tx
          .insert(deadLetterJobs)
          .values({
            originalJobId: job.id,
            userId: job.userId,
            queueId: job.queueId,
            type: job.type,
            payload: job.payload,
            attempts: job.attempts,
            lastError: leaseExpiredError,
            lastErrorMessage: leaseExpiredError.message,
            createdAt: sql`clock_timestamp()`,
            failedAt: sql`clock_timestamp()`,
            metadata: deadLetterMetadata(
              job.metadata,
              leaseExpiredError.message,
              observedAt
            ),
          })
          .onConflictDoNothing({ target: deadLetterJobs.originalJobId });

        await tx.insert(jobEvents).values({
          jobId: job.id,
          eventType: 'lease_expired',
          fromStatus: JobStatus.PROCESSING,
          toStatus: JobStatus.DEAD_LETTERED,
          workerId: job.workerId,
          userId: job.userId,
          metadata: {
            expiredLeaseId: job.leaseId,
            recoveryWorkerId: workerId,
            attemptNumber: job.attempts,
            exhausted: true,
          },
        });

        return { kind: 'TERMINAL', job: deadLetteredJob };
      }

      const [recoveredJob] = await tx
        .update(jobs)
        .set({
          status: JobStatus.QUEUED,
          workerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, JobStatus.PROCESSING),
            eq(jobs.version, job.version)
          )
        )
        .returning();

      if (!recoveredJob) {
        throw new Error(`Failed to recover expired job ${job.id}`);
      }

      await tx.insert(jobEvents).values({
        jobId: job.id,
        eventType: 'lease_expired',
        fromStatus: JobStatus.PROCESSING,
        toStatus: JobStatus.QUEUED,
        workerId: job.workerId,
        userId: job.userId,
        metadata: {
          expiredLeaseId: job.leaseId,
          recoveryWorkerId: workerId,
          attemptNumber: job.attempts,
          exhausted: false,
        },
      });

      job = recoveredJob;
    }

    if (job.status !== JobStatus.QUEUED || !scheduledIsDue) {
      return { kind: 'NOT_READY', job };
    }

    const [leasedJob] = await tx
      .update(jobs)
      .set({
        status: JobStatus.PROCESSING,
        workerId,
        leaseId,
        leaseExpiresAt: sql`clock_timestamp() + (${leaseDurationMs} * INTERVAL '1 millisecond')`,
        startedAt: sql`COALESCE(${jobs.startedAt}, clock_timestamp())`,
        attempts: sql`${jobs.attempts} + 1`,
        version: sql`${jobs.version} + 1`,
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, JobStatus.QUEUED),
          eq(jobs.version, job.version),
          sql`${jobs.scheduledAt} <= clock_timestamp()`
        )
      )
      .returning();

    if (!leasedJob) {
      throw new Error(`Failed to acquire delivery lease for job ${job.id}`);
    }

    await tx.insert(jobEvents).values({
      jobId: job.id,
      eventType: 'lease_acquired',
      fromStatus: JobStatus.QUEUED,
      toStatus: JobStatus.PROCESSING,
      workerId,
      userId: job.userId,
      metadata: {
        leaseId,
        leaseExpiresAt: leasedJob.leaseExpiresAt?.toISOString(),
        attemptNumber: leasedJob.attempts,
      },
    });

    return { kind: 'ACQUIRED', job: leasedJob };
  });
}

/**
 * Persist the beginning of an attempt after a lease is acquired.
 *
 * The uniqueness constraint makes repeated calls for the same delivery
 * idempotent without creating duplicate attempt rows.
 */
export async function startJobAttempt(
  jobId: string,
  workerId: string,
  leaseId: string
): Promise<JobAttempt> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.PROCESSING),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
        )
      )
      .limit(1)
      .for('update');

    if (!job) {
      throw new JobDeliveryLeaseLostError(jobId, 'start attempt for');
    }

    const [createdAttempt] = await tx
      .insert(jobAttempts)
      .values({
        jobId,
        attemptNumber: job.attempts,
        workerId,
        startedAt: sql`clock_timestamp()`,
        status: JobStatus.PROCESSING,
        metadata: { leaseId },
      })
      .onConflictDoNothing({
        target: [jobAttempts.jobId, jobAttempts.attemptNumber],
      })
      .returning();

    if (createdAttempt) {
      return createdAttempt;
    }

    const [existingAttempt] = await tx
      .select()
      .from(jobAttempts)
      .where(
        and(
          eq(jobAttempts.jobId, jobId),
          eq(jobAttempts.attemptNumber, job.attempts),
          eq(jobAttempts.workerId, workerId),
          eq(jobAttempts.status, JobStatus.PROCESSING)
        )
      )
      .limit(1);

    if (!existingAttempt) {
      throw new Error(
        `Attempt ${job.attempts} for job ${jobId} already belongs to another delivery`
      );
    }

    return existingAttempt;
  });
}

/**
 * Renew a lease only while the caller still owns an unexpired fence.
 */
export async function renewJobDeliveryLease(
  jobId: string,
  workerId: string,
  leaseId: string,
  duration: number
): Promise<Job | null> {
  assertPositiveDuration(duration, 'duration');

  const [job] = await db
    .update(jobs)
    .set({
      leaseExpiresAt: sql`clock_timestamp() + (${duration} * INTERVAL '1 millisecond')`,
      version: sql`${jobs.version} + 1`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, JobStatus.PROCESSING),
        eq(jobs.workerId, workerId),
        eq(jobs.leaseId, leaseId),
        sql`${jobs.leaseExpiresAt} > clock_timestamp()`
      )
    )
    .returning();

  return job || null;
}

/**
 * Atomically persist a successful result, finish its attempt, and record the
 * terminal transition. Callers may acknowledge Redis only after this resolves.
 */
export async function completeJobDelivery(
  jobId: string,
  workerId: string,
  leaseId: string,
  result: Record<string, unknown>
): Promise<Job> {
  return db.transaction(async (tx) => {
    const [ownedJob] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.PROCESSING),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
        )
      )
      .limit(1)
      .for('update');

    if (!ownedJob) {
      throw new JobDeliveryLeaseLostError(jobId, 'complete');
    }

    const [completedJob] = await tx
      .update(jobs)
      .set({
        status: JobStatus.SUCCEEDED,
        result,
        error: null,
        completedAt: sql`clock_timestamp()`,
        leaseId: null,
        leaseExpiresAt: null,
        version: sql`${jobs.version} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.PROCESSING),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          eq(jobs.version, ownedJob.version)
        )
      )
      .returning();

    if (!completedJob) {
      throw new JobDeliveryLeaseLostError(jobId, 'complete');
    }

    const [completedAttempt] = await tx
      .update(jobAttempts)
      .set({
        completedAt: sql`clock_timestamp()`,
        durationMs: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - ${jobAttempts.startedAt})) * 1000))::integer`,
        status: JobStatus.SUCCEEDED,
      })
      .where(
        and(
          eq(jobAttempts.jobId, jobId),
          eq(jobAttempts.attemptNumber, ownedJob.attempts),
          eq(jobAttempts.workerId, workerId),
          eq(jobAttempts.status, JobStatus.PROCESSING)
        )
      )
      .returning({ id: jobAttempts.id });

    if (!completedAttempt) {
      throw new Error(
        `Cannot complete job ${jobId}: attempt ${ownedJob.attempts} was not started`
      );
    }

    await tx.insert(jobEvents).values({
      jobId,
      eventType: 'completed',
      fromStatus: JobStatus.PROCESSING,
      toStatus: JobStatus.SUCCEEDED,
      workerId,
      userId: ownedJob.userId,
      metadata: {
        leaseId,
        attemptNumber: ownedJob.attempts,
      },
    });

    return completedJob;
  });
}

/**
 * Atomically finish a failed attempt and either schedule its retry using
 * exponential backoff or persist terminal dead-letter state.
 */
export async function failJobDelivery(
  jobId: string,
  workerId: string,
  leaseId: string,
  error: unknown,
  options: JobDeliveryFailureOptions
): Promise<JobDeliveryFailureOutcome> {
  assertNonNegativeDuration(options.baseDelayMs, 'baseDelayMs');
  assertNonNegativeDuration(options.maxDelayMs, 'maxDelayMs');

  const observedAt = new Date();
  const normalizedError = normalizeDeliveryError(error);

  return db.transaction(async (tx) => {
    const [ownedJob] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.PROCESSING),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
        )
      )
      .limit(1)
      .for('update');

    if (!ownedJob) {
      throw new JobDeliveryLeaseLostError(jobId, 'fail');
    }

    const terminal = ownedJob.attempts >= ownedJob.maxAttempts;
    const retryDelayMs = terminal
      ? undefined
      : calculateRetryDelay(
          ownedJob.attempts,
          options.baseDelayMs,
          options.maxDelayMs
        );
    const nextStatus = terminal
      ? JobStatus.DEAD_LETTERED
      : JobStatus.RETRY_SCHEDULED;
    const [failedJob] = await tx
      .update(jobs)
      .set({
        status: nextStatus,
        error: normalizedError.record,
        failedAt: sql`clock_timestamp()`,
        completedAt: terminal ? sql`clock_timestamp()` : null,
        scheduledAt: terminal
          ? ownedJob.scheduledAt
          : sql`clock_timestamp() + (${retryDelayMs!} * INTERVAL '1 millisecond')`,
        leaseId: null,
        leaseExpiresAt: null,
        version: sql`${jobs.version} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.PROCESSING),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          eq(jobs.version, ownedJob.version)
        )
      )
      .returning();

    if (!failedJob) {
      throw new JobDeliveryLeaseLostError(jobId, 'fail');
    }

    const [failedAttempt] = await tx
      .update(jobAttempts)
      .set({
        completedAt: sql`clock_timestamp()`,
        durationMs: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - ${jobAttempts.startedAt})) * 1000))::integer`,
        status: JobStatus.FAILED,
        error: normalizedError.record,
        errorMessage: normalizedError.message,
        stackTrace: normalizedError.stackTrace,
        metadata: {
          leaseId,
          terminal,
          retryDelayMs,
        },
      })
      .where(
        and(
          eq(jobAttempts.jobId, jobId),
          eq(jobAttempts.attemptNumber, ownedJob.attempts),
          eq(jobAttempts.workerId, workerId),
          eq(jobAttempts.status, JobStatus.PROCESSING)
        )
      )
      .returning({ id: jobAttempts.id });

    if (!failedAttempt) {
      throw new Error(
        `Cannot fail job ${jobId}: attempt ${ownedJob.attempts} was not started`
      );
    }

    if (terminal) {
      await tx
        .insert(deadLetterJobs)
        .values({
          originalJobId: ownedJob.id,
          userId: ownedJob.userId,
          queueId: ownedJob.queueId,
          type: ownedJob.type,
          payload: ownedJob.payload,
          attempts: ownedJob.attempts,
          lastError: normalizedError.record,
          lastErrorMessage: normalizedError.message,
          createdAt: sql`clock_timestamp()`,
          failedAt: sql`clock_timestamp()`,
          metadata: deadLetterMetadata(
            ownedJob.metadata,
            normalizedError.message,
            observedAt
          ),
        })
        .onConflictDoNothing({ target: deadLetterJobs.originalJobId });
    }

    await tx.insert(jobEvents).values({
      jobId,
      eventType: terminal ? 'dead_lettered' : 'failed',
      fromStatus: JobStatus.PROCESSING,
      toStatus: nextStatus,
      workerId,
      userId: ownedJob.userId,
      metadata: {
        leaseId,
        attemptNumber: ownedJob.attempts,
        terminal,
        retryDelayMs,
      },
    });

    if (terminal) {
      return { job: failedJob, terminal: true };
    }

    return {
      job: failedJob,
      terminal: false,
      retryDelayMs: retryDelayMs!,
    };
  });
}

function isTerminalStatus(status: Job['status']): boolean {
  return (
    status === JobStatus.SUCCEEDED ||
    status === JobStatus.CANCELLED ||
    status === JobStatus.DEAD_LETTERED
  );
}

function calculateRetryDelay(
  attemptNumber: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponent = Math.max(0, Math.min(attemptNumber - 1, 30));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

function normalizeDeliveryError(error: unknown): {
  record: Record<string, unknown>;
  message: string;
  stackTrace?: string;
} {
  if (error instanceof Error) {
    const record: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };

    if (error.stack) {
      record.stack = error.stack;
    }

    return {
      record,
      message: error.message,
      stackTrace: error.stack,
    };
  }

  if (isRecord(error)) {
    const message =
      typeof error.message === 'string' ? error.message : 'Job handler failed';
    return { record: error, message };
  }

  const message = typeof error === 'string' ? error : String(error);
  return { record: { message }, message };
}

function deadLetterMetadata(
  metadata: unknown,
  reason: string,
  deadLetteredAt: Date
): Record<string, unknown> {
  return {
    ...(isRecord(metadata) ? metadata : {}),
    deadLetterReason: reason,
    deadLetteredAt: deadLetteredAt.toISOString(),
  };
}

function elapsedMilliseconds(
  startedAt: Date | null,
  completedAt: Date
): number {
  return startedAt
    ? Math.max(0, completedAt.getTime() - startedAt.getTime())
    : 0;
}

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function assertNonNegativeDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
