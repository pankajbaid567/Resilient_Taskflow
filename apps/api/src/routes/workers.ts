import { getWorkerById, listWorkers, type Worker } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { WorkerStatus } from '@taskflow/types';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { requireAdmin } from '../middleware/auth';

const logger = createLogger({ component: 'WorkerRoutes' });

const workerIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
const listWorkersQuerySchema = z
  .object({
    status: z.nativeEnum(WorkerStatus).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

type SerializedWorker = Omit<
  Worker,
  | 'workerName'
  | 'currentJobCount'
  | 'lastHeartbeatAt'
  | 'startedAt'
  | 'stoppedAt'
> & {
  name: string;
  currentJobs: number;
  lastHeartbeat: string;
  startedAt: string;
  stoppedAt: string | null;
};

function serializeWorker(worker: Worker): SerializedWorker {
  return {
    id: worker.id,
    name: worker.workerName,
    hostname: worker.hostname,
    processId: worker.processId,
    queues: worker.queues,
    status: worker.status,
    concurrency: worker.concurrency,
    currentJobs: worker.currentJobCount,
    totalJobsProcessed: worker.totalJobsProcessed,
    totalJobsSucceeded: worker.totalJobsSucceeded,
    totalJobsFailed: worker.totalJobsFailed,
    lastHeartbeat: worker.lastHeartbeatAt.toISOString(),
    startedAt: worker.startedAt.toISOString(),
    stoppedAt: worker.stoppedAt?.toISOString() ?? null,
    version: worker.version,
    metadata: worker.metadata,
  };
}

function sendMissingWorker(reply: FastifyReply, id: string): FastifyReply {
  return reply.status(404).send({
    error: 'Not Found',
    message: `Worker ${id} not found`,
    statusCode: 404,
    timestamp: new Date().toISOString(),
  });
}

/** PostgreSQL-backed worker reads and explicitly unimplemented controls. */
export function workerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      status?: string;
      limit?: string | number;
      offset?: string | number;
    };
  }>('/', async (request, reply) => {
    const query = listWorkersQuerySchema.parse(request.query);

    try {
      const result = await listWorkers(query);
      return reply.send({
        data: result.workers.map(serializeWorker),
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total: result.total,
        },
      });
    } catch (error) {
      logger.error('Failed to list workers', { error });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = workerIdParamsSchema.parse(request.params);
    const worker = await getWorkerById(id);
    if (!worker) return sendMissingWorker(reply, id);
    return reply.send(serializeWorker(worker));
  });

  app.get<{ Params: { id: string } }>('/:id/stats', async (request, reply) => {
    const { id } = workerIdParamsSchema.parse(request.params);
    const worker = await getWorkerById(id);
    if (!worker) return sendMissingWorker(reply, id);

    const successRate =
      worker.totalJobsProcessed === 0
        ? 0
        : worker.totalJobsSucceeded / worker.totalJobsProcessed;

    return reply.send({
      ...serializeWorker(worker),
      successRate,
    });
  });

  app.post<{ Params: { id: string } }>(
    '/:id/stop',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id } = workerIdParamsSchema.parse(request.params);
      if (!(await getWorkerById(id))) return sendMissingWorker(reply, id);

      logger.info('Worker stop requested', { workerId: id });
      return reply.status(501).send({
        error: 'Not Implemented',
        message:
          'Worker stop is unavailable because control signaling is not implemented',
        statusCode: 501,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return Promise.resolve();
}
