
import { getJobCounts } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { getMetrics, jobsCurrentByStatus } from '@taskflow/observability';
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
      jobsCurrentByStatus
        .labels({ status: 'created', queue: 'all' })
        .set(jobCounts.created);
      jobsCurrentByStatus
        .labels({ status: 'queued', queue: 'all' })
        .set(jobCounts.queued);
      jobsCurrentByStatus
        .labels({ status: 'running', queue: 'all' })
        .set(jobCounts.running);
      jobsCurrentByStatus
        .labels({ status: 'completed', queue: 'all' })
        .set(jobCounts.completed);
      jobsCurrentByStatus
        .labels({ status: 'failed', queue: 'all' })
        .set(jobCounts.failed);
      jobsCurrentByStatus
        .labels({ status: 'cancelled', queue: 'all' })
        .set(jobCounts.cancelled);
      jobsCurrentByStatus
        .labels({ status: 'dead_lettered', queue: 'all' })
        .set(jobCounts.dead_lettered);

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
