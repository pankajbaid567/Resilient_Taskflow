import { getJobCounts } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { getMetrics, jobsCurrentByStatus } from '@taskflow/observability';
import { JobStatus } from '@taskflow/types';
import { FastifyInstance } from 'fastify';

const logger = createLogger({ component: 'MetricsRoutes' });

/**
 * Metrics Routes
 *
 * Provides Prometheus-compatible metrics endpoint.
 */
export function metricsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Prometheus metrics
   * GET /metrics
   *
   * Returns comprehensive metrics for monitoring and alerting.
   */
  app.get('/', async (_request, reply) => {
    try {
      // Update job count gauges from database
      const jobCounts = await getJobCounts();
      for (const status of Object.values(JobStatus)) {
        jobsCurrentByStatus
          .labels({ status, queue: 'all' })
          .set(jobCounts[status]);
      }

      // Get all metrics from prom-client registry
      const metricsText = await getMetrics();

      return reply
        .header('Content-Type', 'text/plain; version=0.0.4')
        .send(metricsText);
    } catch (error) {
      logger.error('Failed to generate metrics', { error });
      throw error;
    }
  });

  return Promise.resolve();
}
