import { testConnection } from '@taskflow/database';
import { testRedisConnection } from '@taskflow/queue';
import { FastifyInstance } from 'fastify';

/**
 * Health Check Routes
 */
export function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Basic health check
   * Returns 200 if service is running
   */
  app.get('/', async (_request, reply) => {
    return reply.send({
      status: 'healthy',
    });
  });

  /**
   * Readiness check
   * Returns 200 if service is ready to accept traffic
   * Checks database and Redis connectivity
   */
  app.get('/ready', async (_request, reply) => {
    try {
      const [postgresReady, redisReady] = await Promise.all([
        testConnection(),
        testRedisConnection(),
      ]);
      const isReady = postgresReady && redisReady;
      return reply
        .status(isReady ? 200 : 503)
        .send({ status: isReady ? 'ready' : 'not_ready' });
    } catch {
      return reply.status(503).send({
        status: 'not_ready',
      });
    }
  });

  /**
   * Liveness check
   * Returns 200 if process is alive
   */
  app.get('/live', async (_request, reply) => {
    return reply.send({
      status: 'alive',
    });
  });

  return Promise.resolve();
}
