import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { FastifyInstance } from 'fastify';

import { env } from '@taskflow/config';
import { logger } from '@taskflow/logger';

import { authenticate } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import {
  extractIdempotencyKey,
  checkIdempotency,
} from './middleware/idempotency';
import { rateLimiters } from './middleware/rate-limiter';
import { requestLogger } from './middleware/request-logger';
import { registerSwagger } from './openapi';
import { healthRoutes } from './routes/health';
import { jobRoutes } from './routes/jobs';
import { metricsRoutes } from './routes/metrics';
import { queueRoutes } from './routes/queues';
import { workerRoutes } from './routes/workers';

/**
 * Create and configure Fastify application
 */
export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // Use our Pino logger instead
    disableRequestLogging: true,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => crypto.randomUUID(),
  });

  // Security: Helmet for security headers
  await app.register(helmet, {
    contentSecurityPolicy: false, // Disable for API
    crossOriginEmbedderPolicy: false,
  });

  // CORS configuration
  await app.register(cors, {
    origin: env.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });

  // Register Swagger documentation
  await registerSwagger(app);

  // Custom middleware
  app.addHook('onRequest', requestLogger);

  // Error handler
  app.setErrorHandler(errorHandler);

  // Register routes
  // Health checks (no auth or rate limiting)
  await app.register(healthRoutes, { prefix: '/health' });

  // Metrics endpoint (no auth, lenient rate limiting)
  await app.register(
    async (instance) => {
      instance.addHook('onRequest', rateLimiters.health);
      await instance.register(metricsRoutes);
    },
    { prefix: '/metrics' }
  );

  // API routes (with auth and rate limiting)
  await app.register(
    async (instance) => {
      // Apply authentication to all API routes
      instance.addHook('onRequest', authenticate);

      // Job routes with strict rate limiting and idempotency
      await instance.register(
        async (jobInstance) => {
          jobInstance.addHook('onRequest', rateLimiters.jobSubmission);
          jobInstance.addHook('preHandler', extractIdempotencyKey);
          jobInstance.addHook('preHandler', checkIdempotency);
          await jobInstance.register(jobRoutes);
        },
        { prefix: '/jobs' }
      );

      // Queue routes with read rate limiting
      await instance.register(
        async (queueInstance) => {
          queueInstance.addHook('onRequest', rateLimiters.read);
          await queueInstance.register(queueRoutes);
        },
        { prefix: '/queues' }
      );

      // Worker routes with read rate limiting
      await instance.register(
        async (workerInstance) => {
          workerInstance.addHook('onRequest', rateLimiters.read);
          await workerInstance.register(workerRoutes);
        },
        { prefix: '/workers' }
      );
    },
    { prefix: '/api/v1' }
  );

  // 404 handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method}:${request.url} not found`,
      statusCode: 404,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

/**
 * Start the API server
 */
export async function startServer(): Promise<FastifyInstance> {
  const app = await createApp();

  try {
    await app.listen({
      port: env.API_PORT,
      host: env.API_HOST,
    });

    logger.info(`✓ API server listening on ${env.API_HOST}:${env.API_PORT}`);

    return app;
  } catch (error) {
    logger.error('Failed to start API server', { error });
    process.exit(1);
  }
}
