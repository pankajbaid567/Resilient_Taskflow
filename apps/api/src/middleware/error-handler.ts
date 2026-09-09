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
  const statusCode = error.statusCode || 500;

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
