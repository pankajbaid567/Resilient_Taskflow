import { FastifyReply, FastifyRequest } from 'fastify';

import { createLogger } from '@taskflow/logger';
import { createRedisClient } from '@taskflow/queue';

const logger = createLogger({ component: 'RateLimiter' });

/**
 * Rate Limiter Configuration
 */
export interface RateLimitConfig {
  /**
   * Maximum number of requests allowed in the window
   */
  maxRequests: number;

  /**
   * Time window in seconds
   */
  windowSeconds: number;

  /**
   * Custom key extractor
   * Default: IP address
   */
  keyExtractor?: (request: FastifyRequest) => string;

  /**
   * Skip rate limiting for certain requests
   */
  skip?: (request: FastifyRequest) => boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowSeconds: 60,
};

/**
 * Create rate limiter middleware using Redis
 *
 * Uses sliding window algorithm with Redis sorted sets for accuracy.
 */
export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const finalConfig: RateLimitConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const redis = createRedisClient();

  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    // Skip if configured
    if (finalConfig.skip?.(request)) {
      return;
    }

    // Extract key (IP or custom)
    const key = finalConfig.keyExtractor
      ? finalConfig.keyExtractor(request)
      : extractIpAddress(request);

    const rateLimitKey = `rate-limit:${key}`;
    const now = Date.now();
    const windowStart = now - finalConfig.windowSeconds * 1000;

    try {
      // Remove old entries outside the window
      await redis.zremrangebyscore(rateLimitKey, 0, windowStart);

      // Count requests in current window
      const count = await redis.zcount(rateLimitKey, windowStart, now);

      // Check if limit exceeded
      if (count >= finalConfig.maxRequests) {
        // Get oldest request timestamp for retry-after calculation
        const oldestRequests = await redis.zrange(
          rateLimitKey,
          0,
          0,
          'WITHSCORES'
        );
        const oldestTimestamp = oldestRequests[1]
          ? parseInt(oldestRequests[1], 10)
          : now;
        const retryAfter = Math.ceil(
          (oldestTimestamp + finalConfig.windowSeconds * 1000 - now) / 1000
        );

        logger.warn('Rate limit exceeded', {
          key,
          count,
          limit: finalConfig.maxRequests,
          window: finalConfig.windowSeconds,
          retryAfter,
        });

        reply.header('X-RateLimit-Limit', finalConfig.maxRequests);
        reply.header('X-RateLimit-Remaining', 0);
        reply.header(
          'X-RateLimit-Reset',
          oldestTimestamp + finalConfig.windowSeconds * 1000
        );
        reply.header('Retry-After', retryAfter);

        return reply.status(429).send({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          statusCode: 429,
          timestamp: new Date().toISOString(),
          retryAfter,
        });
      }

      // Add current request to sliding window
      await redis.zadd(rateLimitKey, now, `${now}-${Math.random()}`);

      // Set expiration on key to clean up automatically
      await redis.expire(rateLimitKey, finalConfig.windowSeconds * 2);

      // Add rate limit headers
      const remaining = Math.max(0, finalConfig.maxRequests - count - 1);
      reply.header('X-RateLimit-Limit', finalConfig.maxRequests);
      reply.header('X-RateLimit-Remaining', remaining);
      reply.header('X-RateLimit-Reset', now + finalConfig.windowSeconds * 1000);

      logger.debug('Rate limit check passed', {
        key,
        count: count + 1,
        limit: finalConfig.maxRequests,
        remaining,
      });
    } catch (error) {
      // Log error but don't block request on rate limiter failure
      logger.error('Rate limiter error', { key, error });
      // Fail open - allow request through
    }
  };
}

/**
 * Extract IP address from request
 *
 * Respects X-Forwarded-For header for proxies
 */
function extractIpAddress(request: FastifyRequest): string {
  const forwardedFor = request.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string') {
    // Take the first IP if multiple are present
    return forwardedFor.split(',')[0]?.trim() || request.ip || 'unknown';
  }

  return request.ip || 'unknown';
}

/**
 * Extract user ID from authenticated request
 */
export function extractUserId(request: FastifyRequest): string {
  return request.user?.id || extractIpAddress(request);
}

/**
 * Preset rate limiters
 */
export const rateLimiters = {
  /**
   * Strict rate limiter for job submission
   * 50 requests per minute per user
   */
  jobSubmission: createRateLimiter({
    maxRequests: 50,
    windowSeconds: 60,
    keyExtractor: extractUserId,
  }),

  /**
   * Moderate rate limiter for read operations
   * 200 requests per minute per user
   */
  read: createRateLimiter({
    maxRequests: 200,
    windowSeconds: 60,
    keyExtractor: extractUserId,
  }),

  /**
   * Lenient rate limiter for health checks
   * 1000 requests per minute per IP
   */
  health: createRateLimiter({
    maxRequests: 1000,
    windowSeconds: 60,
  }),
};
