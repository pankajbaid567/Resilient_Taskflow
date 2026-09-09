import crypto from 'crypto';


import { getJobByIdempotencyKey } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { JobPriority, JobResponse, JobStatus } from '@taskflow/types';
import { FastifyReply, FastifyRequest } from 'fastify';

const logger = createLogger({ component: 'IdempotencyMiddleware' });

/**
 * Idempotency Middleware
 *
 * Prevents duplicate job submissions by checking idempotency keys.
 *
 * RFC: https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header
 */

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey?: string;
    requestHash?: string;
  }
}

/**
 * Extract and validate idempotency key from request
 */
export async function extractIdempotencyKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const idempotencyKey = request.headers['idempotency-key'] as
    string | undefined;

  // Idempotency key is optional
  if (!idempotencyKey) {
    return;
  }

  // Validate idempotency key format
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Invalid idempotency key format. Must be 1-255 characters.',
      statusCode: 400,
      timestamp: new Date().toISOString(),
    });
  }

  // Attach to request
  request.idempotencyKey = idempotencyKey;

  // Calculate request hash for replay detection
  request.requestHash = calculateRequestHash(request);
}

/**
 * Check if idempotent request already processed
 */
export async function checkIdempotency(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip if no idempotency key
  if (!request.idempotencyKey) {
    return;
  }

  // Need authenticated user
  if (!request.user) {
    logger.warn('Idempotency check without authentication', {
      requestId: request.id,
    });
    return;
  }

  try {
    // Check if key already used
    const existingJob = await getJobByIdempotencyKey(
      request.user.id,
      request.idempotencyKey
    );

    if (existingJob) {
      logger.info('Idempotent request detected', {
        requestId: request.id,
        idempotencyKey: request.idempotencyKey,
        existingJobId: existingJob.id,
      });

      // Return existing job with 200 OK (already processed)
      const response: JobResponse = {
        id: existingJob.id,
        status: existingJob.status as JobStatus,
        type: existingJob.type,
        queue: 'default', // TODO: Get from relation
        priority: existingJob.priority as JobPriority,
        attempts: existingJob.attempts,
        maxAttempts: existingJob.maxAttempts,
        createdAt: existingJob.createdAt.toISOString(),
        startedAt: existingJob.startedAt?.toISOString() || null,
        completedAt: existingJob.completedAt?.toISOString() || null,
        scheduledAt: existingJob.scheduledAt.toISOString(),
        result: existingJob.result as Record<string, unknown> | null,
        error: existingJob.error as Record<string, unknown> | null,
      };

      // Set Idempotency-Key header in response
      void reply.header('Idempotency-Key', request.idempotencyKey);
      void reply.header('X-Idempotent-Replay', 'true');

      return reply.status(200).send(response);
    }
  } catch (error) {
    logger.error('Idempotency check failed', {
      requestId: request.id,
      error,
    });
    // Continue without idempotency on error (fail open)
  }
}

/**
 * Validate idempotency key format
 *
 * Rules:
 * - Must be 1-255 characters
 * - Should be unique per request
 * - Recommended: UUIDv4 or similar
 */
function isValidIdempotencyKey(key: string): boolean {
  return key.length >= 1 && key.length <= 255;
}

/**
 * Calculate request hash for replay detection
 *
 * Hash includes:
 * - HTTP method
 * - URL path
 * - Request body
 *
 * This prevents different requests from using the same idempotency key.
 */
function calculateRequestHash(request: FastifyRequest): string {
  const hash = crypto.createHash('sha256');

  hash.update(request.method);
  hash.update(request.url);

  if (request.body) {
    hash.update(JSON.stringify(request.body));
  }

  return hash.digest('hex');
}

/**
 * Compare request hashes
 *
 * If idempotency key is reused with different request body,
 * it's a conflict (client error).
 */
export function validateRequestHash(
  storedHash: string,
  currentHash: string
): boolean {
  return storedHash === currentHash;
}

/**
 * Set idempotency response headers
 */
export function setIdempotencyHeaders(
  reply: FastifyReply,
  idempotencyKey: string,
  isReplay: boolean = false
): void {
  void reply.header('Idempotency-Key', idempotencyKey);

  if (isReplay) {
    void reply.header('X-Idempotent-Replay', 'true');
  }
}
