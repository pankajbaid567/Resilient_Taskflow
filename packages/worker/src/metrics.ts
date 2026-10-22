/**
 * Worker-side Prometheus instrumentation.
 *
 * Every function here swallows its own errors: a metrics bug must never fail,
 * delay, or double-run a job. They are also deliberately cheap (counter
 * increments), because they sit on the job hot path.
 *
 * This deep import avoids loading the OpenTelemetry SDK that the package
 * index pulls in (about 70 MB and 130 ms per worker process, none of which a
 * worker uses).
 */
import {
  dispatcherPublishedTotal,
  dispatcherWindowLimitedTotal,
  jobDurationSeconds,
  jobsCancelledTotal,
  jobsCompletedTotal,
  jobsDeadLetteredTotal,
  jobsFailedTotal,
  jobsRetriedTotal,
  jobsStartedTotal,
  jobWaitDurationSeconds,
  jobsTimedOutTotal,
  schedulerErrorsTotal,
  schedulerJobsScheduledTotal,
  schedulerRunDurationSeconds,
  schedulerRunsTotal,
  workerHeartbeatsTotal,
  workerJobsConcurrent,
  workerLeaseAcquisitionFailuresTotal,
  workerLeaseRenewalsTotal,
} from '@taskflow/observability/dist/metrics';

function safely(record: () => void): void {
  try {
    record();
  } catch {
    // Intentionally ignored: see the module comment.
  }
}

export type DeadLetterReason = 'permanent' | 'timeout' | 'max_attempts';

export const workerMetrics = {
  jobStarted(queue: string, type: string, workerId: string): void {
    safely(() => jobsStartedTotal.inc({ queue, type, worker_id: workerId }, 1));
  },

  /**
   * Time from a job becoming due to a worker starting it. This is where
   * priority shows up: a CRITICAL job should wait less than a LOW one.
   */
  jobWaited(queue: string, priority: string, waitMs: number): void {
    safely(() =>
      jobWaitDurationSeconds.observe(
        { queue, priority },
        Math.max(0, waitMs) / 1000
      )
    );
  },

  jobSucceeded(queue: string, type: string, durationMs: number): void {
    safely(() => {
      jobsCompletedTotal.inc({ queue, type }, 1);
      jobDurationSeconds.observe(
        { queue, type, status: 'SUCCEEDED' },
        durationMs / 1000
      );
    });
  },

  /** One failed attempt. `retried` distinguishes a retry from a dead letter. */
  jobFailed(args: {
    queue: string;
    type: string;
    errorType: string;
    durationMs: number;
    attempt: number;
    terminal: boolean;
    deadLetterReason: DeadLetterReason;
  }): void {
    const { queue, type } = args;
    safely(() => {
      jobsFailedTotal.inc({ queue, type, error_type: args.errorType }, 1);
      jobDurationSeconds.observe(
        { queue, type, status: 'FAILED' },
        args.durationMs / 1000
      );
      if (args.terminal) {
        jobsDeadLetteredTotal.inc(
          { queue, type, reason: args.deadLetterReason },
          1
        );
      } else {
        jobsRetriedTotal.inc({ queue, type, attempt: String(args.attempt) }, 1);
      }
    });
  },

  jobTimedOut(queue: string, type: string): void {
    safely(() => jobsTimedOutTotal.inc({ queue, type }, 1));
  },

  jobCancelled(queue: string, type: string): void {
    safely(() => jobsCancelledTotal.inc({ queue, type }, 1));
  },

  runningJobs(workerId: string, count: number): void {
    safely(() => workerJobsConcurrent.set({ worker_id: workerId }, count));
  },

  heartbeat(workerId: string): void {
    safely(() => workerHeartbeatsTotal.inc({ worker_id: workerId }, 1));
  },

  leaseRenewed(workerId: string): void {
    safely(() => workerLeaseRenewalsTotal.inc({ worker_id: workerId }, 1));
  },

  /** A delivery that did not become a lease: contention, not an error. */
  leaseNotAcquired(workerId: string, reason: string): void {
    safely(() =>
      workerLeaseAcquisitionFailuresTotal.inc(
        { worker_id: workerId, reason },
        1
      )
    );
  },

  schedulerCycle(args: {
    durationMs: number;
    promotedPriorities: string[];
    failures: number;
  }): void {
    safely(() => {
      schedulerRunsTotal.inc(1);
      schedulerRunDurationSeconds.observe(args.durationMs / 1000);
      for (const priority of args.promotedPriorities) {
        schedulerJobsScheduledTotal.inc({ priority }, 1);
      }
      if (args.failures > 0) {
        schedulerErrorsTotal.inc({ error_type: 'promotion' }, args.failures);
      }
    });
  },

  schedulerCycleFailed(): void {
    safely(() => {
      schedulerRunsTotal.inc(1);
      schedulerErrorsTotal.inc({ error_type: 'cycle' }, 1);
    });
  },

  dispatcherPublished(queue: string): void {
    safely(() => dispatcherPublishedTotal.inc({ queue }, 1));
  },

  dispatcherWindowLimited(queue: string): void {
    safely(() => dispatcherWindowLimitedTotal.inc({ queue }, 1));
  },
};
