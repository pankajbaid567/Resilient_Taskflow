import { sql } from '@taskflow/database';
import type { JobHandler, JobHandlerContext } from '@taskflow/types';

interface TestIdempotentPayload {
  effectKey?: string;
  delayMs?: number;
  delayFirstAttemptMs?: number;
  effectBeforeDelay?: boolean;
  alwaysFail?: boolean;
  ignoreCancellation?: boolean;
}

async function sleepWithCancellation(
  ms: number,
  cancellationToken: JobHandlerContext['cancellationToken'],
  ignoreCancellation: boolean
): Promise<void> {
  if (ignoreCancellation) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  cancellationToken.throwIfCancellationRequested();

  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      new Promise<never>((_, reject) => {
        unsubscribe = cancellationToken.onCancellationRequested(() => {
          try {
            cancellationToken.throwIfCancellationRequested();
          } catch (error) {
            reject(error);
          }
        });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
  }
}

async function persistEffect(
  jobId: string,
  effectKey: string
): Promise<boolean> {
  await sql`
    INSERT INTO test_effect_attempts (job_id, effect_key)
    VALUES (${jobId}, ${effectKey})
  `;

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
  const ignoreCancellation = options.ignoreCancellation === true;

  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error('delayMs must be an integer between 0 and 60000');
  }

  if (!ignoreCancellation) {
    context.cancellationToken.throwIfCancellationRequested();
  }

  await sql`
    INSERT INTO test_handler_executions (job_id)
    VALUES (${context.job.id})
  `;

  if (!ignoreCancellation) {
    context.cancellationToken.throwIfCancellationRequested();
  }

  let effectInserted = false;
  if (options.effectBeforeDelay) {
    effectInserted = await persistEffect(context.job.id, effectKey);
  }

  if (delayMs > 0) {
    await sleepWithCancellation(
      delayMs,
      context.cancellationToken,
      ignoreCancellation
    );
  }

  if (!ignoreCancellation) {
    context.cancellationToken.throwIfCancellationRequested();
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
