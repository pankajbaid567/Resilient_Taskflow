import { performance } from 'node:perf_hooks';

export type ShutdownResource = 'http' | 'redis' | 'database' | 'tracing';
export type ShutdownFailureKind = 'error' | 'timeout';

export interface ShutdownFailure {
  resource: ShutdownResource;
  kind: ShutdownFailureKind;
  error?: unknown;
}

export interface ShutdownDependencies {
  timeoutMs: number;
  closeHttp: () => Promise<void>;
  closeRedis: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  closeTracing: () => Promise<void>;
  monotonicNow?: () => number;
}

export class ApplicationShutdownError extends Error {
  constructor(
    public readonly signal: string,
    public readonly failures: ShutdownFailure[]
  ) {
    super(
      `Application shutdown failed for: ${failures
        .map(({ resource, kind }) => `${resource} (${kind})`)
        .join(', ')}`
    );
    this.name = 'ApplicationShutdownError';
  }
}

async function settleWithin(
  resource: ShutdownResource,
  close: () => Promise<void>,
  timeoutMs: number
): Promise<ShutdownFailure | null> {
  const closeOutcome = Promise.resolve()
    .then(close)
    .then<ShutdownFailure | null>(() => null)
    .catch((error: unknown): ShutdownFailure => ({
      resource,
      kind: 'error',
      error,
    }));

  if (timeoutMs <= 0) {
    return { resource, kind: 'timeout' };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ShutdownFailure>((resolve) => {
    timer = setTimeout(() => resolve({ resource, kind: 'timeout' }), timeoutMs);
  });

  try {
    return await Promise.race([closeOutcome, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Create one idempotent, bounded shutdown operation.
 *
 * Half of the configured deadline is reserved for Fastify to stop accepting
 * work and drain requests. Redis, PostgreSQL, and tracing then close in
 * parallel using the rest of the same overall deadline. A timed-out close may
 * still settle in the background, but every closer is invoked exactly once.
 */
export function createShutdownController(
  dependencies: ShutdownDependencies
): (signal: string) => Promise<void> {
  if (!Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 2) {
    throw new Error('Shutdown timeout must be an integer of at least 2ms');
  }

  let shutdownPromise: Promise<void> | undefined;
  const monotonicNow =
    dependencies.monotonicNow ?? performance.now.bind(performance);

  return (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      const startedAt = monotonicNow();
      const deadlineAt = startedAt + dependencies.timeoutMs;
      const httpBudgetMs = Math.max(1, Math.floor(dependencies.timeoutMs / 2));
      const failures: ShutdownFailure[] = [];

      const httpFailure = await settleWithin(
        'http',
        dependencies.closeHttp,
        httpBudgetMs
      );
      if (httpFailure) failures.push(httpFailure);

      const remainingMs = Math.max(0, deadlineAt - monotonicNow());
      const dependencyFailures = await Promise.all([
        settleWithin('redis', dependencies.closeRedis, remainingMs),
        settleWithin('database', dependencies.closeDatabase, remainingMs),
        settleWithin('tracing', dependencies.closeTracing, remainingMs),
      ]);

      for (const failure of dependencyFailures) {
        if (failure) failures.push(failure);
      }

      if (failures.length > 0) {
        throw new ApplicationShutdownError(signal, failures);
      }
    })();

    return shutdownPromise;
  };
}
