import crypto from 'crypto';

import { FastifyReply, FastifyRequest } from 'fastify';

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
  const idempotencyKey = request.headers['idempotency-key'];

  // Idempotency key is optional
  if (!idempotencyKey) {
    return;
  }

  // Validate idempotency key format
  if (
    typeof idempotencyKey !== 'string' ||
    !isValidIdempotencyKey(idempotencyKey)
  ) {
    return reply.status(400).send({
      error: 'Bad Request',
      message:
        'Invalid idempotency key format. Must be 1-255 visible ASCII characters.',
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
 * Validate idempotency key format
 *
 * Rules:
 * - Must be 1-255 characters
 * - Should be unique per request
 * - Recommended: UUIDv4 or similar
 */
function isValidIdempotencyKey(key: string): boolean {
  return /^[\x21-\x7e]{1,255}$/.test(key);
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
  hash.update(request.url.split('?', 1)[0] ?? request.url);

  if (request.body) {
    hash.update(stableJson(request.body));
  }

  return hash.digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
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
