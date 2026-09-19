import { decideJobRetry } from '@taskflow/retry';
import { JobStatus } from '@taskflow/types';
import { and, eq, getTableColumns, or, sql } from 'drizzle-orm';

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
  type JobDelivery,
} from '../schema';

import { insertPendingDelivery } from './dispatch.repository';

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
  | {
      job: Job;
      terminal: false;
      retryDelayMs: number;
      successorDelivery: JobDelivery;
    };

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
 * Raised when cancellation completion is attempted without a durable request.
 */
export class JobCancellationNotRequestedError extends Error {
  constructor(jobId: string, status: Job['status']) {
    super(
      `Cannot complete cancellation for job ${jobId}: current status is ${status}`
    );
    this.name = 'JobCancellationNotRequestedError';
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

    if (job.status === JobStatus.CANCEL_REQUESTED) {
      if (job.leaseExpiresAt && leaseIsActive) {
        return { kind: 'BUSY', job };
      }

      const [cancelledJob] = await tx
        .update(jobs)
        .set({
          status: JobStatus.CANCELLED,
          completedAt: sql`clock_timestamp()`,
          leaseId: null,
          leaseExpiresAt: null,
          version: sql`${jobs.version} + 1`,
          eventSequence: sql`${jobs.eventSequence} + 1`,
        })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, JobStatus.CANCEL_REQUESTED),
            eq(jobs.version, job.version),
            or(
              sql`${jobs.leaseExpiresAt} IS NULL`,
              sql`${jobs.leaseExpiresAt} <= clock_timestamp()`
            )
          )
        )
        .returning();

      if (!cancelledJob) {
        throw new Error(`Failed to recover cancelled job ${job.id}`);
      }

      if (job.attempts > 0) {
        const cancellationError = {
          code: 'CANCELLED',
          message: 'Job cancellation recovered after its lease expired',
        };
        const [cancelledAttempt] = await tx
          .update(jobAttempts)
          .set({
            completedAt: sql`clock_timestamp()`,
            durationMs: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - ${jobAttempts.startedAt})) * 1000))::integer`,
            status: JobStatus.CANCELLED,
            error: cancellationError,
            errorMessage: cancellationError.message,
            metadata: {
              leaseId: job.leaseId,
              reason: 'cancellation_recovered_after_lease_expiry',
              recoveryWorkerId: workerId,
            },
          })
          .where(
            and(
              eq(jobAttempts.jobId, job.id),
              eq(jobAttempts.attemptNumber, job.attempts),
              eq(jobAttempts.status, JobStatus.PROCESSING)
            )
          )
          .returning({ id: jobAttempts.id });

        if (!cancelledAttempt) {
          await tx.insert(jobAttempts).values({
            jobId: job.id,
            attemptNumber: job.attempts,
            workerId: job.workerId,
            // No current-attempt row means the execution boundary was never
            // durably recorded. Do not reuse jobs.startedAt, which may belong
            // to the first attempt of a retrying job.
            startedAt: observedAt,
            completedAt: sql`clock_timestamp()`,
            durationMs: 0,
            status: JobStatus.CANCELLED,
            error: cancellationError,
            errorMessage: cancellationError.message,
            metadata: {
              leaseId: job.leaseId,
              reason: 'cancellation_recovered_after_lease_expiry',
              recoveryWorkerId: workerId,
              attemptRecordMissing: true,
            },
          });
        }
      }

      await tx.insert(jobEvents).values({
        jobId: job.id,
        eventType: 'cancelled',
        sequence: cancelledJob.eventSequence,
        fromStatus: JobStatus.CANCEL_REQUESTED,
        toStatus: JobStatus.CANCELLED,
        workerId,
        userId: job.userId,
        metadata: {
          expiredLeaseId: job.leaseId,
          previousWorkerId: job.workerId,
          recoveryWorkerId: workerId,
          attemptNumber: job.attempts,
          reason: 'lease_expired_after_cancellation_request',
        },
      });

      return { kind: 'TERMINAL', job: cancelledJob };
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
          eventSequence: sql`${jobs.eventSequence} + 1`,
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
        sequence: promotedJob.eventSequence,
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
      if (job.leaseExpiresAt && leaseIsActive) {
        return { kind: 'BUSY', job };
      }

      const leaseExpiredError = {
        code: 'LEASE_EXPIRED',
        message: 'Worker lease expired before the attempt completed',
      };

      if (job.attempts > 0) {
        const [expiredAttempt] = await tx
          .update(jobAttempts)
          .set({
            completedAt: sql`clock_timestamp()`,
            durationMs: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - ${jobAttempts.startedAt})) * 1000))::integer`,
            status: JobStatus.FAILED,
            error: leaseExpiredError,
            errorMessage: leaseExpiredError.message,
            metadata: {
              reason: 'lease_expired',
              leaseId: job.leaseId,
            },
          })
          .where(
            and(
              eq(jobAttempts.jobId, job.id),
              eq(jobAttempts.attemptNumber, job.attempts),
              eq(jobAttempts.status, JobStatus.PROCESSING)
            )
          )
          .returning({ id: jobAttempts.id });

        if (!expiredAttempt) {
          await tx.insert(jobAttempts).values({
            jobId: job.id,
            attemptNumber: job.attempts,
            workerId: job.workerId,
            startedAt: observedAt,
            completedAt: sql`clock_timestamp()`,
            durationMs: 0,
            status: JobStatus.FAILED,
            error: leaseExpiredError,
            errorMessage: leaseExpiredError.message,
            metadata: {
              reason: 'lease_expired',
              leaseId: job.leaseId,
              attemptRecordMissing: true,
            },
          });
        }
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
            eventSequence: sql`${jobs.eventSequence} + 1`,
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
          sequence: deadLetteredJob.eventSequence,
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
          eventSequence: sql`${jobs.eventSequence} + 1`,
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
        sequence: recoveredJob.eventSequence,
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

    const [queue] = await tx
      .select({ isActive: queues.isActive })
      .from(queues)
      .where(eq(queues.id, job.queueId))
      .limit(1);
    if (!queue?.isActive) {
      return { kind: 'NOT_READY', job };
    }

    if (job.attempts >= job.maxAttempts) {
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
        eventSequence: sql`${jobs.eventSequence} + 1`,
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, JobStatus.QUEUED),
          eq(jobs.version, job.version),
          sql`${jobs.scheduledAt} <= clock_timestamp()`,
          sql`${jobs.attempts} < ${jobs.maxAttempts}`
        )
      )
      .returning();

    if (!leasedJob) {
      throw new Error(`Failed to acquire delivery lease for job ${job.id}`);
    }

    await tx.insert(jobEvents).values({
      jobId: job.id,
      eventType: 'lease_acquired',
      sequence: leasedJob.eventSequence,
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
      const [sequencedJob] = await tx
        .update(jobs)
        .set({ eventSequence: sql`${jobs.eventSequence} + 1` })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, JobStatus.PROCESSING),
            eq(jobs.workerId, workerId),
            eq(jobs.leaseId, leaseId),
            eq(jobs.version, job.version),
            sql`${jobs.leaseExpiresAt} > clock_timestamp()`
          )
        )
        .returning();

      if (!sequencedJob) {
        throw new JobDeliveryLeaseLostError(jobId, 'start attempt for');
      }

      await tx.insert(jobEvents).values({
        jobId,
        eventType: 'attempt_started',
        sequence: sequencedJob.eventSequence,
        fromStatus: JobStatus.PROCESSING,
        toStatus: JobStatus.PROCESSING,
        workerId,
        userId: job.userId,
        metadata: {
          leaseId,
          attemptNumber: job.attempts,
        },
      });

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
 * Renew a lease only while the caller still owns an unexpired fence. A
 * cancellation request retains that fence so the owner can observe the state,
 * stop its handler, and durably complete cancellation.
 */
export async function renewJobDeliveryLease(
  jobId: string,
  workerId: string,
  leaseId: string,
  duration: number
): Promise<Job | null> {
  assertPositiveDuration(duration, 'duration');

  return db.transaction(async (tx) => {
    const [job] = await tx
      .update(jobs)
      .set({
        leaseExpiresAt: sql`clock_timestamp() + (${duration} * INTERVAL '1 millisecond')`,
        version: sql`${jobs.version} + 1`,
        eventSequence: sql`${jobs.eventSequence} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          or(
            eq(jobs.status, JobStatus.PROCESSING),
            eq(jobs.status, JobStatus.CANCEL_REQUESTED)
          ),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
        )
      )
      .returning();

    if (!job) {
      return null;
    }

    await tx.insert(jobEvents).values({
      jobId,
      eventType: 'lease_renewed',
      sequence: job.eventSequence,
      fromStatus: job.status,
      toStatus: job.status,
      workerId,
      userId: job.userId,
      metadata: {
        leaseId,
        leaseExpiresAt: job.leaseExpiresAt?.toISOString(),
        attemptNumber: job.attempts,
      },
    });

    return job;
  });
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
        eventSequence: sql`${jobs.eventSequence} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.PROCESSING),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          eq(jobs.version, ownedJob.version),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
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
      sequence: completedJob.eventSequence,
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
 * Atomically finish a failed attempt and either persist terminal dead-letter
 * state or schedule its retry with a unique successor delivery intent.
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

    const retryDecision = decideJobRetry({
      currentAttempt: ownedJob.attempts,
      maxAttempts: ownedJob.maxAttempts,
      error,
      jobCreatedAt: ownedJob.createdAt,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
    });
    const terminal = !retryDecision.shouldRetry;
    const retryDelayMs = retryDecision.shouldRetry
      ? retryDecision.delayMs
      : undefined;
    const retryAvailableAt = retryDecision.shouldRetry
      ? sql<Date>`transaction_timestamp() + (${retryDecision.delayMs} * INTERVAL '1 millisecond')`
      : undefined;
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
        scheduledAt: terminal ? ownedJob.scheduledAt : retryAvailableAt!,
        leaseId: null,
        leaseExpiresAt: null,
        version: sql`${jobs.version} + 1`,
        eventSequence: sql`${jobs.eventSequence} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.PROCESSING),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          eq(jobs.version, ownedJob.version),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
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
          retryReason: retryDecision.reason,
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
      sequence: failedJob.eventSequence,
      fromStatus: JobStatus.PROCESSING,
      toStatus: nextStatus,
      workerId,
      userId: ownedJob.userId,
      metadata: {
        leaseId,
        attemptNumber: ownedJob.attempts,
        terminal,
        retryDelayMs,
        retryReason: retryDecision.reason,
      },
    });

    if (!retryDecision.shouldRetry) {
      return { job: failedJob, terminal: true };
    }

    const [queue] = await tx
      .select({ name: queues.name })
      .from(queues)
      .where(eq(queues.id, ownedJob.queueId))
      .limit(1);

    if (!queue) {
      throw new Error(
        `Queue ${ownedJob.queueId} not found while scheduling retry for job ${jobId}`
      );
    }

    const successorDelivery = await insertPendingDelivery(
      tx,
      jobId,
      queue.name,
      retryDecision.nextAttempt,
      retryAvailableAt
    );

    if (
      successorDelivery.status !== 'PENDING' ||
      successorDelivery.attempt !== retryDecision.nextAttempt ||
      successorDelivery.availableAt.getTime() !==
        failedJob.scheduledAt.getTime()
    ) {
      throw new Error(
        `Retry successor for job ${jobId} does not match the durable retry state`
      );
    }

    return {
      job: failedJob,
      terminal: false,
      retryDelayMs: retryDecision.delayMs,
      successorDelivery,
    };
  });
}

/**
 * Atomically transition a job from CANCEL_REQUESTED to CANCELLED.
 *
 * Called by the worker after the handler has acknowledged the cancellation
 * signal (via CancellationToken) and stopped executing. The worker must
 * still own a valid lease at the time of this call.
 *
 * After this call the Redis entry can be safely XACK'd without concern for
 * duplicate delivery — the TERMINAL result will be returned by
 * acquireJobForDelivery on any subsequent reclaim attempt.
 */
export async function completeCancellation(
  jobId: string,
  workerId: string,
  leaseId: string
): Promise<Job> {
  return db.transaction(async (tx) => {
    // Re-validate ownership under a row lock. The lease may have been
    // revoked concurrently (e.g., by a replacement worker that recovered
    // an expired cancellation request).
    const [ownedJob] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
        )
      )
      .limit(1)
      .for('update');

    if (!ownedJob) {
      throw new JobDeliveryLeaseLostError(jobId, 'complete cancellation for');
    }

    if (ownedJob.status !== JobStatus.CANCEL_REQUESTED) {
      throw new JobCancellationNotRequestedError(jobId, ownedJob.status);
    }

    const [cancelledJob] = await tx
      .update(jobs)
      .set({
        status: JobStatus.CANCELLED,
        completedAt: sql`clock_timestamp()`,
        leaseId: null,
        leaseExpiresAt: null,
        version: sql`${jobs.version} + 1`,
        eventSequence: sql`${jobs.eventSequence} + 1`,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.CANCEL_REQUESTED),
          eq(jobs.workerId, workerId),
          eq(jobs.leaseId, leaseId),
          eq(jobs.version, ownedJob.version),
          sql`${jobs.leaseExpiresAt} > clock_timestamp()`
        )
      )
      .returning();

    if (!cancelledJob) {
      throw new JobDeliveryLeaseLostError(jobId, 'complete cancellation for');
    }

    // Record the attempt as cancelled. Calculate duration from the current
    // attempt row when it exists; jobs.startedAt can describe an earlier retry.
    if (ownedJob.attempts > 0) {
      const cancellationError = {
        code: 'CANCELLED',
        message: 'Job was cancelled',
      };
      const [cancelledAttempt] = await tx
        .update(jobAttempts)
        .set({
          completedAt: sql`clock_timestamp()`,
          durationMs: sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - ${jobAttempts.startedAt})) * 1000))::integer`,
          status: JobStatus.CANCELLED,
          error: cancellationError,
          errorMessage: cancellationError.message,
          metadata: { leaseId, reason: 'cancellation_requested' },
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

      if (!cancelledAttempt) {
        throw new Error(
          `Cannot cancel job ${jobId}: attempt ${ownedJob.attempts} was not started`
        );
      }
    }

    await tx.insert(jobEvents).values({
      jobId,
      eventType: 'cancelled',
      sequence: cancelledJob.eventSequence,
      fromStatus: ownedJob.status,
      toStatus: JobStatus.CANCELLED,
      workerId,
      userId: ownedJob.userId,
      metadata: {
        leaseId,
        attemptNumber: ownedJob.attempts,
        previousStatus: ownedJob.status,
      },
    });

    return cancelledJob;
  });
}

function isTerminalStatus(status: Job['status']): boolean {
  return (
    status === JobStatus.SUCCEEDED ||
    status === JobStatus.CANCELLED ||
    status === JobStatus.DEAD_LETTERED
  );
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
    if ('code' in error && typeof error.code === 'string') {
      record.code = error.code;
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
