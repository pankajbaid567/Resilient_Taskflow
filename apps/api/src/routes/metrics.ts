import { getMetricsSnapshot } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { getMetrics } from '@taskflow/observability';
import { FastifyInstance } from 'fastify';

import { publishSystemGauges } from '../metrics';

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
      // System-wide gauges are recomputed from PostgreSQL on every scrape.
      publishSystemGauges(await getMetricsSnapshot());
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
