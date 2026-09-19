import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRateLimiter,
  SLIDING_WINDOW_LUA,
} from '../middleware/rate-limiter';

const openApps: FastifyInstance[] = [];
type RedisEvalArguments = [string, number, ...Array<string | number>];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function appWithLimiter(
  limiter: ReturnType<typeof createRateLimiter>,
  trustProxy: boolean | string | string[] | number = false
): {
  app: FastifyInstance;
  handler: ReturnType<typeof vi.fn<[], { ok: boolean }>>;
} {
  const app = Fastify({ trustProxy });
  const handler = vi.fn(() => ({ ok: true }));
  app.addHook('onRequest', limiter);
  app.get('/', handler);
  openApps.push(app);
  return { app, handler };
}

describe('atomic Redis rate limiter', () => {
  it('uses one scoped EVAL and ignores spoofed forwarding headers by default', async () => {
    const timestamp = 1_700_000_000_000;
    const evalRedis = vi.fn<RedisEvalArguments, Promise<unknown>>();
    evalRedis.mockResolvedValue([1, 1, timestamp, timestamp]);
    const limiter = createRateLimiter(
      {
        scope: 'read',
        maxRequests: 2,
        windowSeconds: 10,
        failureMode: 'open',
      },
      {
        getRedisClient: () => ({ eval: evalRedis }),
        now: () => timestamp,
        memberId: () => 'member-1',
      }
    );
    const { app } = appWithLimiter(limiter);

    const response = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '198.51.100.22' },
    });

    expect(response.statusCode).toBe(200);
    expect(evalRedis).toHaveBeenCalledTimes(1);
    const evaluation = evalRedis.mock.calls[0];
    expect(evaluation?.slice(0, 5)).toEqual([
      SLIDING_WINDOW_LUA,
      1,
      'taskflow:rate-limit:read:10.0.0.5',
      10_000,
      2,
    ]);
    expect(evaluation?.[5]).toBe('member-1');
    expect(response.headers['x-ratelimit-limit']).toBe('2');
    expect(response.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('uses Fastify request.ip when an exact proxy is trusted', async () => {
    const timestamp = 1_700_000_000_000;
    const evalRedis = vi.fn<RedisEvalArguments, Promise<unknown>>();
    evalRedis.mockResolvedValue([1, 1, timestamp, timestamp]);
    const limiter = createRateLimiter(
      {
        scope: 'observability',
        maxRequests: 10,
        windowSeconds: 60,
        failureMode: 'open',
      },
      {
        getRedisClient: () => ({ eval: evalRedis }),
        now: () => timestamp,
        memberId: () => 'member-2',
      }
    );
    const { app } = appWithLimiter(limiter, ['10.0.0.5']);

    await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '198.51.100.22' },
    });

    expect(evalRedis.mock.calls[0]?.[2]).toBe(
      'taskflow:rate-limit:observability:198.51.100.22'
    );
  });

  it('returns the atomic denial decision without invoking the route', async () => {
    const timestamp = 1_700_000_000_000;
    const evalRedis = vi.fn<RedisEvalArguments, Promise<unknown>>();
    evalRedis.mockResolvedValue([0, 2, timestamp - 4_000, timestamp]);
    const limiter = createRateLimiter(
      {
        scope: 'job-submission',
        maxRequests: 2,
        windowSeconds: 10,
        failureMode: 'closed',
      },
      {
        getRedisClient: () => ({ eval: evalRedis }),
        now: () => timestamp,
      }
    );
    const { app, handler } = appWithLimiter(limiter);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: 'Too Many Requests',
      retryAfter: 6,
    });
    expect(response.headers['retry-after']).toBe('6');
    expect(response.headers['x-ratelimit-remaining']).toBe('0');
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails writes closed and reads open when Redis is unavailable', async () => {
    const redisError = new Error('Redis unavailable');
    const closedLimiter = createRateLimiter(
      {
        scope: 'mutation',
        maxRequests: 2,
        windowSeconds: 10,
        failureMode: 'closed',
      },
      {
        getRedisClient: () => ({
          eval: vi.fn().mockRejectedValue(redisError),
        }),
      }
    );
    const openLimiter = createRateLimiter(
      {
        scope: 'read',
        maxRequests: 2,
        windowSeconds: 10,
        failureMode: 'open',
      },
      {
        getRedisClient: () => ({
          eval: vi.fn().mockRejectedValue(redisError),
        }),
      }
    );
    const closed = appWithLimiter(closedLimiter);
    const open = appWithLimiter(openLimiter);

    const [closedResponse, openResponse] = await Promise.all([
      closed.app.inject({ method: 'GET', url: '/' }),
      open.app.inject({ method: 'GET', url: '/' }),
    ]);

    expect(closedResponse.statusCode).toBe(503);
    expect(closed.handler).not.toHaveBeenCalled();
    expect(openResponse.statusCode).toBe(200);
    expect(open.handler).toHaveBeenCalledTimes(1);
  });
});
