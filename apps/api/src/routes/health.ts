import { testConnection } from '@taskflow/database';
import { testRedisConnection } from '@taskflow/queue';
import { HealthCheck } from '@taskflow/types';
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
      timestamp: new Date().toISOString(),
      service: 'taskflow-api',
    });
  });

  /**
   * Readiness check
   * Returns 200 if service is ready to accept traffic
   * Checks database and Redis connectivity
   */
  app.get('/ready', async (_request, reply) => {
    const checks = {
      postgres: false,
      redis: false,
      kafka: false, // TODO: Add Kafka check when implemented
    };

    try {
      // Check PostgreSQL
      checks.postgres = await testConnection();

      // Check Redis
      checks.redis = await testRedisConnection();

      // Determine overall status
      const isHealthy = checks.postgres && checks.redis;
      const status: HealthCheck['status'] = isHealthy
        ? 'healthy'
        : checks.kafka === false
          ? 'degraded' // Kafka optional for now
          : 'unhealthy';

      const response: HealthCheck = {
        status,
        timestamp: new Date().toISOString(),
        checks,
      };

      return reply.status(isHealthy ? 200 : 503).send(response);
    } catch (error) {
      return reply.status(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        checks,
        error: error instanceof Error ? error.message : 'Unknown error',
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
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  });

  return Promise.resolve();
}
