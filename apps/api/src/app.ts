import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { apiConfig, env } from '@taskflow/config';
import { cleanupExpiredIdempotencyKeys } from '@taskflow/database';
import { logger } from '@taskflow/logger';
import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authenticate } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { extractIdempotencyKey } from './middleware/idempotency';
import { rateLimiters } from './middleware/rate-limiter';
import { requestLogger } from './middleware/request-logger';
import { registerSwagger } from './openapi';
import { healthRoutes } from './routes/health';
import { jobRoutes } from './routes/jobs';
import { metricsRoutes } from './routes/metrics';
import { queueRoutes } from './routes/queues';
import { workerRoutes } from './routes/workers';

export type ApiRequestPolicy = 'job-submission' | 'read' | 'mutation';

export interface CreateAppOptions {
  enableSwagger?: boolean;
  trustProxy?: false | string | string[];
  idempotencyCleanupIntervalMs?: number | false;
}

export interface StartServerOptions {
  app?: FastifyInstance;
  host?: string;
  port?: number;
}

/** Swagger UI is never mounted in production and can be disabled elsewhere. */
export function shouldEnableSwagger(
  nodeEnvironment: string,
  override?: boolean
): boolean {
  return nodeEnvironment !== 'production' && (override ?? true);
}

function normalizedPath(url: string): string {
  const path = url.split('?', 1)[0] ?? url;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Classify requests once so rate limiting and idempotency share route scope. */
export function getJobRequestPolicy(
  request: Pick<FastifyRequest, 'method' | 'url'>
): ApiRequestPolicy {
  if (
    request.method === 'POST' &&
    normalizedPath(request.url) === '/api/v1/jobs'
  ) {
    return 'job-submission';
  }

  if (
    request.method === 'GET' ||
    request.method === 'HEAD' ||
    request.method === 'OPTIONS'
  ) {
    return 'read';
  }

  return 'mutation';
}

async function applyJobRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const policy = getJobRequestPolicy(request);

  if (policy === 'job-submission') {
    await rateLimiters.jobSubmission(request, reply);
    return;
  }

  if (policy === 'read') {
    await rateLimiters.read(request, reply);
    return;
  }

  await rateLimiters.mutation(request, reply);
}

async function applyNonJobRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const isRead =
    request.method === 'GET' ||
    request.method === 'HEAD' ||
    request.method === 'OPTIONS';
  await (isRead ? rateLimiters.read : rateLimiters.mutation)(request, reply);
}

async function applyJobIdempotency(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (getJobRequestPolicy(request) !== 'job-submission') {
    return;
  }

  await extractIdempotencyKey(request, reply);
}

/**
 * Create and configure Fastify application
 */
export async function createApp(
  options: CreateAppOptions = {}
): Promise<FastifyInstance> {
  const idempotencyCleanupIntervalMs =
    options.idempotencyCleanupIntervalMs ?? 3_600_000;
  if (
    idempotencyCleanupIntervalMs !== false &&
    (!Number.isInteger(idempotencyCleanupIntervalMs) ||
      idempotencyCleanupIntervalMs < 1)
  ) {
    throw new Error('Idempotency cleanup interval must be positive or false');
  }

  const configuredTrustProxy =
    apiConfig.trustedProxies.length > 0 ? [...apiConfig.trustedProxies] : false;
  const app = Fastify({
    logger: false, // Use our Pino logger instead
    disableRequestLogging: true,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => crypto.randomUUID(),
    trustProxy: options.trustProxy ?? configuredTrustProxy,
  });

  let idempotencyCleanupTimer: NodeJS.Timeout | undefined;
  if (idempotencyCleanupIntervalMs !== false) {
    app.addHook('onReady', (done) => {
      idempotencyCleanupTimer = setInterval(() => {
        void cleanupExpiredIdempotencyKeys().catch((error: unknown) => {
          logger.error(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            'Expired idempotency-key cleanup failed'
          );
        });
      }, idempotencyCleanupIntervalMs);
      idempotencyCleanupTimer.unref();
      done();
    });
    app.addHook('onClose', (_instance, done) => {
      if (idempotencyCleanupTimer) clearInterval(idempotencyCleanupTimer);
      idempotencyCleanupTimer = undefined;
      done();
    });
  }

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

  // Interactive API documentation is disabled in production by default.
  if (shouldEnableSwagger(env.NODE_ENV, options.enableSwagger)) {
    await registerSwagger(app);
  }

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
          jobInstance.addHook('onRequest', applyJobRateLimit);
          jobInstance.addHook('preHandler', applyJobIdempotency);
          await jobInstance.register(jobRoutes);
        },
        { prefix: '/jobs' }
      );

      // Queue routes with read rate limiting
      await instance.register(
        async (queueInstance) => {
          queueInstance.addHook('onRequest', applyNonJobRateLimit);
          await queueInstance.register(queueRoutes);
        },
        { prefix: '/queues' }
      );

      // Worker routes with read rate limiting
      await instance.register(
        async (workerInstance) => {
          workerInstance.addHook('onRequest', applyNonJobRateLimit);
          await workerInstance.register(workerRoutes);
        },
        { prefix: '/workers' }
      );
    },
    { prefix: '/api/v1' }
  );

  // 404 handler
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
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
export async function startServer(
  options: StartServerOptions = {}
): Promise<FastifyInstance> {
  const app = options.app ?? (await createApp());

  try {
    await app.listen({
      port: options.port ?? env.API_PORT,
      host: options.host ?? env.API_HOST,
    });

    logger.info('✓ API server listening', {
      host: options.host ?? env.API_HOST,
      port: options.port ?? env.API_PORT,
    });

    return app;
  } catch (error) {
    logger.error('Failed to start API server', { error });
    try {
      await app.close();
    } catch (closeError) {
      logger.error('Failed to close API after listen error', { closeError });
    }
    throw error;
  }
}
