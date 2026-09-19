import { createRequestLogger } from '@taskflow/logger';
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Request Logger Middleware
 *
 * Logs all incoming requests and responses with timing information.
 */
export function requestLogger(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const requestId = request.id;
  const logger = createRequestLogger(requestId);

  // Log incoming request
  logger.info('Incoming request', {
    method: request.method,
    url: request.url,
    headers: {
      'user-agent': request.headers['user-agent'],
      'content-type': request.headers['content-type'],
    },
  });

  // Track request start time
  const startTime = Date.now();

  // Fastify hooks belong to an application instance, not a reply. Listening on
  // the underlying response keeps this middleware request-scoped and records
  // the status that was actually written to the client.
  reply.raw.once('finish', () => {
    const duration = Date.now() - startTime;

    logger.info('Request completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: duration,
    });
  });

  return Promise.resolve();
}
