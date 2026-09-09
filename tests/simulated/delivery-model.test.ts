import { describe, expect, it } from 'vitest';

/**
 * This deliberately models at-least-once delivery; it is not runtime evidence.
 * The Docker-process suite verifies the same distinction with Redis/PostgreSQL.
 */
describe('simulated at-least-once delivery model', () => {
  it('counts duplicate executions separately from idempotent effects', () => {
    const executions: string[] = [];
    const effects = new Set<string>();

    const execute = (jobId: string, effectKey: string) => {
      executions.push(jobId);
      effects.add(`${jobId}:${effectKey}`);
    };

    execute('job-1', 'send-once');
    execute('job-1', 'send-once');

    expect(executions).toHaveLength(2);
    expect(effects).toEqual(new Set(['job-1:send-once']));
  });
});
