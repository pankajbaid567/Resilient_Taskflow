import { FastifyInstance } from 'fastify';

import { getQueueByName, getQueueStats } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { getQueueDepth } from '@taskflow/queue';

const logger = createLogger({ component: 'QueueRoutes' });

/**
 * Queue Routes
 *
 * Provides queue statistics and management.
 */
export async function queueRoutes(app: FastifyInstance): Promise<void> {
  /**
   * List all queues
   * GET /api/v1/queues
   */
  app.get('/', async (_request, reply) => {
    try {
      // TODO: Get queues from database
      // For now, return hardcoded queues
      const queues = [
        {
          id: 'default-queue-id',
          name: 'default',
          description: 'Default queue for general jobs',
          maxConcurrency: 10,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'email-queue-id',
          name: 'email',
          description: 'Queue for email jobs',
          maxConcurrency: 5,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'critical-queue-id',
          name: 'critical',
          description: 'Queue for critical priority jobs',
          maxConcurrency: 20,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'low-queue-id',
          name: 'low',
          description: 'Queue for low priority jobs',
          maxConcurrency: 3,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      ];

      return reply.send({ data: queues });
    } catch (error) {
      logger.error('Failed to list queues', { error });
      throw error;
    }
  });

  /**
   * Get queue statistics
   * GET /api/v1/queues/:name/stats
   */
  app.get<{ Params: { name: string } }>(
    '/:name/stats',
    async (request, reply) => {
      const { name } = request.params;

      try {
        const queue = await getQueueByName(name);
        if (!queue) {
          return reply.status(404).send({
            error: 'Not Found',
            message: `Queue ${name} not found`,
            statusCode: 404,
            timestamp: new Date().toISOString(),
          });
        }

        // Get job counts from database using the queue's UUID foreign key.
        const dbStats = await getQueueStats(queue.id);

        // Get Redis queue depth
        const redisDepth = await getQueueDepth(name);

        const stats = {
          queue: name,
          timestamp: new Date().toISOString(),
          jobs: {
            queued: dbStats?.queued ?? 0,
            processing: dbStats?.processing ?? 0,
            succeeded: dbStats?.succeeded ?? 0,
            failed: dbStats?.failed ?? 0,
          },
          redis: {
            depth: redisDepth,
          },
          workers: {
            active: 0, // TODO: Get from worker registry
            idle: 0,
          },
          performance: {
            avgDurationMs: dbStats?.avgDurationMs ?? 0,
            p50DurationMs: 0,
            p95DurationMs: 0,
            p99DurationMs: 0,
            throughputPerMin: 0,
          },
        };

        return reply.send(stats);
      } catch (error) {
        logger.error('Failed to get queue stats', { queue: name, error });
        throw error;
      }
    }
  );

  /**
   * Pause a queue
   * POST /api/v1/queues/:name/pause
   */
  app.post<{ Params: { name: string } }>(
    '/:name/pause',
    async (request, reply) => {
      const { name } = request.params;

      // TODO: Implement queue pausing
      // - Update queue.isActive = false in database
      // - Workers should stop pulling from this queue

      logger.info('Queue pause requested', { queue: name });

      return reply.status(501).send({
        error: 'Not Implemented',
        message: 'Queue pause not yet implemented',
        statusCode: 501,
        timestamp: new Date().toISOString(),
      });
    }
  );

  /**
   * Resume a queue
   * POST /api/v1/queues/:name/resume
   */
  app.post<{ Params: { name: string } }>(
    '/:name/resume',
    async (request, reply) => {
      const { name } = request.params;

      // TODO: Implement queue resuming
      // - Update queue.isActive = true in database
      // - Workers can resume pulling from this queue

      logger.info('Queue resume requested', { queue: name });

      return reply.status(501).send({
        error: 'Not Implemented',
        message: 'Queue resume not yet implemented',
        statusCode: 501,
        timestamp: new Date().toISOString(),
      });
    }
  );
}
