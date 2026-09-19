import {
  countActiveWorkersForQueue,
  getQueueByName,
  getQueueStats,
  listQueues,
  type Queue,
} from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { getQueueDepth } from '@taskflow/queue';
import { queueNameSchema } from '@taskflow/types';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { requireAdmin } from '../middleware/auth';

const logger = createLogger({ component: 'QueueRoutes' });

const queueNameParamsSchema = z.object({ name: queueNameSchema }).strict();
const listQueuesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

type SerializedQueue = Omit<Queue, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

function serializeQueue(queue: Queue): SerializedQueue {
  return {
    id: queue.id,
    name: queue.name,
    displayName: queue.displayName,
    description: queue.description,
    priority: queue.priority,
    concurrencyLimit: queue.concurrencyLimit,
    maxRetryAttempts: queue.maxRetryAttempts,
    defaultTimeoutMs: queue.defaultTimeoutMs,
    rateLimitPerMinute: queue.rateLimitPerMinute,
    isActive: queue.isActive,
    createdAt: queue.createdAt.toISOString(),
    updatedAt: queue.updatedAt.toISOString(),
  };
}

function sendMissingQueue(reply: FastifyReply, name: string): FastifyReply {
  return reply.status(404).send({
    error: 'Not Found',
    message: `Queue ${name} not found`,
    statusCode: 404,
    timestamp: new Date().toISOString(),
  });
}

/** PostgreSQL-backed queue reads and explicitly unimplemented controls. */
export function queueRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      limit?: string | number;
      offset?: string | number;
    };
  }>('/', async (request, reply) => {
    const query = listQueuesQuerySchema.parse(request.query);

    try {
      const result = await listQueues(query);
      return reply.send({
        data: result.queues.map(serializeQueue),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: result.total,
        },
      });
    } catch (error) {
      logger.error('Failed to list queues', { error });
      throw error;
    }
  });

  app.get<{ Params: { name: string } }>(
    '/:name/stats',
    async (request, reply) => {
      const { name } = queueNameParamsSchema.parse(request.params);

      try {
        const queue = await getQueueByName(name);
        if (!queue) return sendMissingQueue(reply, name);

        const [dbStats, redisDepth, activeWorkers] = await Promise.all([
          getQueueStats(queue.id),
          getQueueDepth(name),
          countActiveWorkersForQueue(name),
        ]);

        return reply.send({
          queue: name,
          timestamp: new Date().toISOString(),
          jobs: {
            queued: Number(dbStats?.queued ?? 0),
            processing: Number(dbStats?.processing ?? 0),
            succeeded: Number(dbStats?.succeeded ?? 0),
            failed: Number(dbStats?.failed ?? 0),
          },
          redis: {
            depth: redisDepth,
          },
          workers: {
            active: activeWorkers,
          },
          performance: {
            avgDurationMs: Number(dbStats?.avgDurationMs ?? 0),
          },
        });
      } catch (error) {
        logger.error('Failed to get queue stats', { queue: name, error });
        throw error;
      }
    }
  );

  app.post<{ Params: { name: string } }>(
    '/:name/pause',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { name } = queueNameParamsSchema.parse(request.params);
      if (!(await getQueueByName(name))) return sendMissingQueue(reply, name);

      logger.info('Queue pause requested', { queue: name });
      return reply.status(501).send({
        error: 'Not Implemented',
        message:
          'Queue pause is unavailable because control signaling is not implemented',
        statusCode: 501,
        timestamp: new Date().toISOString(),
      });
    }
  );

  app.post<{ Params: { name: string } }>(
    '/:name/resume',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { name } = queueNameParamsSchema.parse(request.params);
      if (!(await getQueueByName(name))) return sendMissingQueue(reply, name);

      logger.info('Queue resume requested', { queue: name });
      return reply.status(501).send({
        error: 'Not Implemented',
        message:
          'Queue resume is unavailable because control signaling is not implemented',
        statusCode: 501,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return Promise.resolve();
}
