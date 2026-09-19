import {
  IdempotencyConflictError,
  InvalidStateTransitionError,
} from '@taskflow/database';
import { logger } from '@taskflow/logger';
import { ApiErrorResponse } from '@taskflow/types';
import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * Global Error Handler
 *
 * Catches all errors and returns consistent error responses.
 */
export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const requestId = request.id;

  // Zod validation errors
  if (error instanceof ZodError) {
    const response: ApiErrorResponse = {
      error: 'Validation Error',
      message: 'Request validation failed',
      statusCode: 400,
      timestamp: new Date().toISOString(),
      path: request.url,
      details: error.errors,
    };

    logger.warn('Validation error', {
      requestId,
      errors: error.errors,
      method: request.method,
      url: request.url,
    });

    return reply.status(400).send(response);
  }

  if (error instanceof IdempotencyConflictError) {
    return reply.status(409).send({
      error: 'Conflict',
      message: error.message,
      statusCode: 409,
      timestamp: new Date().toISOString(),
      path: request.url,
    } satisfies ApiErrorResponse);
  }

  if (error instanceof InvalidStateTransitionError) {
    return reply.status(409).send({
      error: 'Conflict',
      message: error.message,
      statusCode: 409,
      timestamp: new Date().toISOString(),
      path: request.url,
    } satisfies ApiErrorResponse);
  }

  // Fastify validation errors
  if (error.validation) {
    const response: ApiErrorResponse = {
      error: 'Validation Error',
      message: error.message,
      statusCode: 400,
      timestamp: new Date().toISOString(),
      path: request.url,
      details: error.validation,
    };

    logger.warn('Validation error', {
      requestId,
      error: error.message,
      validation: error.validation,
    });

    return reply.status(400).send(response);
  }

  // Determine status code
  const databaseCode = (error as FastifyError & { code?: string }).code;
  const statusCode =
    error.statusCode ?? databaseStatusCode(databaseCode) ?? 500;

  // Create error response
  const response: ApiErrorResponse = {
    error: statusCode >= 500 ? 'Internal Server Error' : error.name || 'Error',
    message:
      statusCode >= 500 && process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : error.message,
    statusCode,
    timestamp: new Date().toISOString(),
    path: request.url,
  };

  // Log appropriately based on severity
  if (statusCode >= 500) {
    logger.error('Server error', {
      requestId,
      error: error.message,
      stack: error.stack,
      method: request.method,
      url: request.url,
    });
  } else {
    logger.warn('Client error', {
      requestId,
      error: error.message,
      statusCode,
      method: request.method,
      url: request.url,
    });
  }

  return reply.status(statusCode).send(response);
}

function databaseStatusCode(code: string | undefined): number | undefined {
  if (!code) return undefined;
  if (code === '23505' || code === '23503') return 409;
  if (code === '23514' || code === '22P02') return 400;
  if (
    code.startsWith('08') ||
    code.startsWith('57P') ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
  ) {
    return 503;
  }
  return undefined;
}
