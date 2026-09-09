import { sql } from '@taskflow/database';
import type { JobHandler } from '@taskflow/types';

interface TestIdempotentPayload {
  effectKey?: string;
  delayMs?: number;
  delayFirstAttemptMs?: number;
  effectBeforeDelay?: boolean;
  alwaysFail?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistEffect(
  jobId: string,
  effectKey: string
): Promise<boolean> {
  const inserted = await sql`
    INSERT INTO test_effects (job_id, effect_key)
    VALUES (${jobId}, ${effectKey})
    ON CONFLICT (job_id, effect_key) DO NOTHING
    RETURNING job_id
  `;

  return inserted.length === 1;
}

/**
 * Process-level integration handler.
 *
 * Each invocation is recorded, while its observable effect is protected by a
 * database uniqueness constraint. This lets the failure tests demonstrate
 * retries and at-least-once execution without fabricating attempt counts.
 */
export const testIdempotentHandler: JobHandler = async (payload, context) => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('test-idempotent handler is available only in test mode');
  }

  const options = payload as TestIdempotentPayload;
  const delayMs =
    context.job.attempts === 1 && options.delayFirstAttemptMs !== undefined
      ? options.delayFirstAttemptMs
      : (options.delayMs ?? 0);
  const effectKey = options.effectKey ?? 'default';

  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error('delayMs must be an integer between 0 and 60000');
  }

  await sql`
    INSERT INTO test_handler_executions (job_id)
    VALUES (${context.job.id})
  `;

  let effectInserted = false;
  if (options.effectBeforeDelay) {
    effectInserted = await persistEffect(context.job.id, effectKey);
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  if (options.alwaysFail) {
    throw new Error('test-idempotent requested transient failure');
  }

  if (!options.effectBeforeDelay) {
    effectInserted = await persistEffect(context.job.id, effectKey);
  }

  return {
    effectKey,
    effectInserted,
  };
};
