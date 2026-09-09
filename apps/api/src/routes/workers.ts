import { FastifyInstance } from 'fastify';

import { getActiveWorkers, getWorkerById } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';

const logger = createLogger({ component: 'WorkerRoutes' });

/**
 * Worker Routes
 *
 * Provides worker status and management.
 */
export async function workerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * List all workers
   * GET /api/v1/workers
   */
  app.get<{
    Querystring: {
      status?: 'ACTIVE' | 'IDLE' | 'STOPPED';
      limit?: number;
      offset?: number;
    };
  }>('/', async (request, reply) => {
    const { status, limit = 50, offset = 0 } = request.query;

    try {
      const activeWorkers = await getActiveWorkers();
      const matchingWorkers =
        status && status !== 'ACTIVE' ? [] : activeWorkers;
      const workers = matchingWorkers.slice(
        offset,
        offset + Math.min(limit, 100)
      );

      const response = workers.map((worker) => ({
        id: worker.id,
        name: worker.workerName,
        queues: worker.queues,
        status: worker.status,
        concurrency: worker.concurrency,
        currentJobs: worker.currentJobCount,
        lastHeartbeat: worker.lastHeartbeatAt.toISOString(),
        createdAt: worker.startedAt.toISOString(),
        metadata: worker.metadata,
      }));

      return reply.send({
        data: response,
        pagination: {
          limit,
          offset,
          total: response.length, // TODO: Get actual count
        },
      });
    } catch (error) {
      logger.error('Failed to list workers', { error });
      throw error;
    }
  });

  /**
   * Get worker by ID
   * GET /api/v1/workers/:id
   */
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    const worker = await getWorkerById(id);

    if (!worker) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Worker ${id} not found`,
        statusCode: 404,
        timestamp: new Date().toISOString(),
      });
    }

    const response = {
      id: worker.id,
      name: worker.workerName,
      queues: worker.queues,
      status: worker.status,
      concurrency: worker.concurrency,
      currentJobs: worker.currentJobCount,
      lastHeartbeat: worker.lastHeartbeatAt.toISOString(),
      createdAt: worker.startedAt.toISOString(),
      metadata: worker.metadata,
    };

    return reply.send(response);
  });

  /**
   * Get worker statistics
   * GET /api/v1/workers/:id/stats
   */
  app.get<{ Params: { id: string } }>('/:id/stats', async (request, reply) => {
    const { id } = request.params;

    // TODO: Implement worker stats
    // - Total jobs processed
    // - Success/failure rates
    // - Average processing time
    // - Current load

    logger.info('Worker stats requested', { workerId: id });

    return reply.status(501).send({
      error: 'Not Implemented',
      message: 'Worker stats not yet implemented',
      statusCode: 501,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Stop a worker
   * POST /api/v1/workers/:id/stop
   */
  app.post<{ Params: { id: string } }>('/:id/stop', async (request, reply) => {
    const { id } = request.params;

    // TODO: Implement worker stopping
    // - Send signal to worker to gracefully shut down
    // - Worker should finish current jobs and stop accepting new ones

    logger.info('Worker stop requested', { workerId: id });

    return reply.status(501).send({
      error: 'Not Implemented',
      message: 'Worker stop not yet implemented',
      statusCode: 501,
      timestamp: new Date().toISOString(),
    });
  });
}
