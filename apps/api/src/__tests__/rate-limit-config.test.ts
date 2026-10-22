import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({ eval: vi.fn() }));

vi.mock('@taskflow/queue', () => ({
  createRedisClient: () => redis,
}));

type PresetName = 'jobSubmission' | 'mutation' | 'read' | 'health';

/**
 * Load the preset limiters fresh, so the configuration is read from the
 * environment as it is right now (the presets are built at import time).
 */
async function limitHeaderFor(preset: PresetName): Promise<string | undefined> {
  vi.resetModules();
  const { rateLimiters } = await import('../middleware/rate-limiter');

  const app = Fastify();
  app.addHook('onRequest', rateLimiters[preset]);
  app.get('/', () => ({ ok: true }));

  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    return response.headers['x-ratelimit-limit'] as string | undefined;
  } finally {
    await app.close();
  }
}

const VARIABLES = [
  'RATE_LIMIT_JOB_SUBMISSION_PER_MIN',
  'RATE_LIMIT_MUTATION_PER_MIN',
  'RATE_LIMIT_READ_PER_MIN',
  'RATE_LIMIT_METRICS_PER_MIN',
] as const;

const originals = new Map<string, string | undefined>(
  VARIABLES.map((name) => [name, process.env[name]])
);

/** Set a variable, or truly unset it (an empty string is not "unset"). */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('rate limit presets read their limits from the environment', () => {
  beforeEach(() => {
    // Start every test from "nothing configured", whatever .env contains.
    for (const name of VARIABLES) setEnv(name, undefined);
    redis.eval.mockReset();
    // [allowed, count, oldest, now]
    redis.eval.mockResolvedValue([1, 1, 1_700_000_000_000, 1_700_000_000_000]);
  });

  afterEach(() => {
    for (const [name, value] of originals) setEnv(name, value);
  });

  it('keeps the documented defaults when nothing is set', async () => {
    expect(await limitHeaderFor('jobSubmission')).toBe('50');
    expect(await limitHeaderFor('mutation')).toBe('50');
    expect(await limitHeaderFor('read')).toBe('200');
    expect(await limitHeaderFor('health')).toBe('1000');
  });

  it.each([
    ['jobSubmission', 'RATE_LIMIT_JOB_SUBMISSION_PER_MIN', '1234'],
    ['mutation', 'RATE_LIMIT_MUTATION_PER_MIN', '77'],
    ['read', 'RATE_LIMIT_READ_PER_MIN', '9'],
    ['health', 'RATE_LIMIT_METRICS_PER_MIN', '4321'],
  ] as const)('%s follows %s', async (preset, variable, value) => {
    setEnv(variable, value);

    expect(await limitHeaderFor(preset)).toBe(value);
  });

  it('changes only the class that was configured', async () => {
    setEnv('RATE_LIMIT_READ_PER_MIN', '9');

    expect(await limitHeaderFor('read')).toBe('9');
    expect(await limitHeaderFor('jobSubmission')).toBe('50');
  });
});
