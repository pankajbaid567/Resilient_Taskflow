import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getMetrics,
  jobsCompletedTotal,
} from '@taskflow/observability/dist/metrics';

import { workerMetrics } from '../metrics';

/** Value of one exposed series, or undefined if it was never emitted. */
async function sample(series: string): Promise<number | undefined> {
  const text = await getMetrics();
  const line = text
    .split('\n')
    .find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.split(' ').pop());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker metrics recorder', () => {
  it('counts a success under the right series and records its duration', async () => {
    workerMetrics.jobSucceeded('q-success', 'email', 2_500);

    expect(
      await sample(
        'taskflow_jobs_completed_total{queue="q-success",type="email"}'
      )
    ).toBe(1);
    expect(
      await sample(
        'taskflow_job_duration_seconds_sum{queue="q-success",type="email",status="SUCCEEDED"}'
      )
    ).toBe(2.5);
    expect(
      await sample(
        'taskflow_job_duration_seconds_count{queue="q-success",type="email",status="SUCCEEDED"}'
      )
    ).toBe(1);
  });

  it('separates a retry from a dead letter', async () => {
    workerMetrics.jobFailed({
      queue: 'q-fail',
      type: 'report',
      errorType: 'TypeError',
      durationMs: 100,
      attempt: 2,
      terminal: false,
      deadLetterReason: 'max_attempts',
    });
    workerMetrics.jobFailed({
      queue: 'q-fail',
      type: 'report',
      errorType: 'PermanentJobError',
      durationMs: 100,
      attempt: 1,
      terminal: true,
      deadLetterReason: 'permanent',
    });

    expect(
      await sample(
        'taskflow_jobs_failed_total{queue="q-fail",type="report",error_type="TypeError"}'
      )
    ).toBe(1);
    expect(
      await sample(
        'taskflow_jobs_retried_total{queue="q-fail",type="report",attempt="2"}'
      )
    ).toBe(1);
    expect(
      await sample(
        'taskflow_jobs_dead_lettered_total{queue="q-fail",type="report",reason="permanent"}'
      )
    ).toBe(1);
    // A dead letter is not also counted as a retry.
    expect(
      await sample(
        'taskflow_jobs_retried_total{queue="q-fail",type="report",attempt="1"}'
      )
    ).toBeUndefined();
  });

  it('keeps the running-jobs gauge at the last value set', async () => {
    workerMetrics.runningJobs('w-gauge', 3);
    workerMetrics.runningJobs('w-gauge', 1);

    expect(
      await sample('taskflow_worker_jobs_concurrent{worker_id="w-gauge"}')
    ).toBe(1);
  });

  it('records scheduler cycles, per-priority promotions and failures', async () => {
    workerMetrics.schedulerCycle({
      durationMs: 40,
      promotedPriorities: ['HIGH', 'HIGH', 'LOW'],
      failures: 2,
    });

    expect(
      await sample('taskflow_scheduler_jobs_scheduled_total{priority="HIGH"}')
    ).toBe(2);
    expect(
      await sample('taskflow_scheduler_jobs_scheduled_total{priority="LOW"}')
    ).toBe(1);
    expect(
      await sample('taskflow_scheduler_errors_total{error_type="promotion"}')
    ).toBe(2);
  });

  it('records dispatcher publication and a full window per queue', async () => {
    workerMetrics.dispatcherPublished('q-dispatch');
    workerMetrics.dispatcherPublished('q-dispatch');
    workerMetrics.dispatcherWindowLimited('q-dispatch');

    expect(
      await sample('taskflow_dispatcher_published_total{queue="q-dispatch"}')
    ).toBe(2);
    expect(
      await sample(
        'taskflow_dispatcher_window_limited_total{queue="q-dispatch"}'
      )
    ).toBe(1);
  });

  it('can never throw into the job path, even if the metric itself fails', () => {
    vi.spyOn(jobsCompletedTotal, 'inc').mockImplementation(() => {
      throw new Error('prom-client exploded');
    });

    expect(() => workerMetrics.jobSucceeded('q', 't', 1)).not.toThrow();
  });
});
