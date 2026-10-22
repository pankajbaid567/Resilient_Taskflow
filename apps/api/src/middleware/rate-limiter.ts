import { randomUUID } from 'node:crypto';

import { rateLimitConfig } from '@taskflow/config';
import { createLogger } from '@taskflow/logger';
import { createRedisClient } from '@taskflow/queue';
import { FastifyReply, FastifyRequest } from 'fastify';

const logger = createLogger({ component: 'RateLimiter' });

/**
 * The whole sliding-window decision is made in one Redis command. In
 * particular, concurrent callers cannot both observe the same count and then
 * add themselves after the limit check.
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local redis_time = redis.call('TIME')
local now = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
local window_start = now - window_ms

redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  redis.call('PEXPIRE', key, window_ms * 2)
  return { 0, count, tonumber(oldest[2]) or now, now }
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms * 2)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return { 1, count + 1, tonumber(oldest[2]) or now, now }
`;

export type RateLimitFailureMode = 'open' | 'closed';

export interface RateLimitConfig {
  /** Stable namespace so independent endpoint policies never share quota. */
  scope: string;
  maxRequests: number;
  windowSeconds: number;

  /**
   * Reads use fail-open availability; state-changing operations use
   * fail-closed safety when Redis cannot make an admission decision.
   */
  failureMode: RateLimitFailureMode;
  keyExtractor?: (request: FastifyRequest) => string;
  skip?: (request: FastifyRequest) => boolean;
}

interface RateLimitRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

export interface RateLimiterDependencies {
  getRedisClient?: () => RateLimitRedisClient;
  now?: () => number;
  memberId?: () => string;
}

interface RateLimitDecision {
  allowed: boolean;
  count: number;
  oldestTimestamp: number;
  nowTimestamp: number;
}

function parseDecision(result: unknown): RateLimitDecision {
  if (!Array.isArray(result) || result.length !== 4) {
    throw new Error('Redis returned an invalid rate-limit decision');
  }

  const allowed = Number(result[0]);
  const count = Number(result[1]);
  const oldestTimestamp = Number(result[2]);
  const nowTimestamp = Number(result[3]);

  if (
    (allowed !== 0 && allowed !== 1) ||
    !Number.isFinite(count) ||
    !Number.isFinite(oldestTimestamp) ||
    !Number.isFinite(nowTimestamp)
  ) {
    throw new Error('Redis returned an invalid rate-limit decision');
  }

  return {
    allowed: allowed === 1,
    count,
    oldestTimestamp,
    nowTimestamp,
  };
}

function buildRateLimitKey(scope: string, identity: string): string {
  return `taskflow:rate-limit:${scope}:${encodeURIComponent(identity)}`;
}

/** Create a rate limiter backed by one atomic Redis Lua decision. */
export function createRateLimiter(
  config: RateLimitConfig,
  dependencies: RateLimiterDependencies = {}
) {
  if (!/^[a-z0-9_-]+$/i.test(config.scope)) {
    throw new Error(
      'Rate-limit scope must contain only letters, numbers, _ or -'
    );
  }

  if (!Number.isInteger(config.maxRequests) || config.maxRequests < 1) {
    throw new Error('Rate-limit maxRequests must be a positive integer');
  }

  if (!Number.isInteger(config.windowSeconds) || config.windowSeconds < 1) {
    throw new Error('Rate-limit windowSeconds must be a positive integer');
  }

  const getRedisClient =
    dependencies.getRedisClient ?? (() => createRedisClient());
  const now = dependencies.now ?? Date.now;
  const memberId = dependencies.memberId ?? randomUUID;

  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    if (config.skip?.(request)) {
      return;
    }

    const identity = config.keyExtractor
      ? config.keyExtractor(request)
      : extractIpAddress(request);
    const rateLimitKey = buildRateLimitKey(config.scope, identity);
    const timestamp = now();
    const windowMs = config.windowSeconds * 1000;

    try {
      const result = await getRedisClient().eval(
        SLIDING_WINDOW_LUA,
        1,
        rateLimitKey,
        windowMs,
        config.maxRequests,
        memberId()
      );
      const decision = parseDecision(result);
      const resetAt = decision.oldestTimestamp + windowMs;

      void reply.header('X-RateLimit-Limit', config.maxRequests);
      void reply.header(
        'X-RateLimit-Remaining',
        Math.max(0, config.maxRequests - decision.count)
      );
      void reply.header('X-RateLimit-Reset', resetAt);

      if (!decision.allowed) {
        const retryAfter = Math.max(
          1,
          Math.ceil((resetAt - decision.nowTimestamp) / 1000)
        );

        logger.warn('Rate limit exceeded', {
          scope: config.scope,
          count: decision.count,
          limit: config.maxRequests,
          windowSeconds: config.windowSeconds,
          retryAfter,
        });

        void reply.header('Retry-After', retryAfter);
        await reply.status(429).send({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          statusCode: 429,
          timestamp: new Date(timestamp).toISOString(),
          retryAfter,
        });
        return;
      }

      logger.debug('Rate limit check passed', {
        scope: config.scope,
        count: decision.count,
        limit: config.maxRequests,
        remaining: Math.max(0, config.maxRequests - decision.count),
      });
    } catch (error) {
      logger.error('Rate limiter unavailable', {
        scope: config.scope,
        failureMode: config.failureMode,
        error,
      });

      if (config.failureMode === 'closed') {
        await reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Request admission is temporarily unavailable',
          statusCode: 503,
          timestamp: new Date(timestamp).toISOString(),
        });
      }
    }
  };
}

/** Fastify derives this value according to the configured trustProxy policy. */
function extractIpAddress(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

/** Extract user ID after authentication, otherwise use the trusted IP. */
export function extractUserId(request: FastifyRequest): string {
  return request.user?.id || extractIpAddress(request);
}

/** Preset policies. Mutations fail closed; observability/read traffic fails open. */
export const rateLimiters = {
  jobSubmission: createRateLimiter({
    scope: 'job-submission',
    maxRequests: rateLimitConfig.jobSubmissionPerWindow,
    windowSeconds: rateLimitConfig.windowSeconds,
    failureMode: 'closed',
    keyExtractor: extractUserId,
  }),

  mutation: createRateLimiter({
    scope: 'mutation',
    maxRequests: rateLimitConfig.mutationPerWindow,
    windowSeconds: rateLimitConfig.windowSeconds,
    failureMode: 'closed',
    keyExtractor: extractUserId,
  }),

  read: createRateLimiter({
    scope: 'read',
    maxRequests: rateLimitConfig.readPerWindow,
    windowSeconds: rateLimitConfig.windowSeconds,
    failureMode: 'open',
    keyExtractor: extractUserId,
  }),

  health: createRateLimiter({
    scope: 'observability',
    maxRequests: rateLimitConfig.metricsPerWindow,
    windowSeconds: rateLimitConfig.windowSeconds,
    failureMode: 'open',
  }),
};
