import {
  cancelJobForUser,
  createJob,
  createJobWithIdempotency,
  getJobForUser,
  getJobsForUser,
  getQueueByName,
  recordOperationalAudit,
  retryDeadLetteredJobForUser,
  type JobWithQueue,
} from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import {
  JobPriority,
  JobStatus,
  submitJobSchema,
  type JobResponse,
  type SubmitJobRequest,
} from '@taskflow/types';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

const logger = createLogger({ component: 'JobRoutes' });

const jobIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
const listJobsQuerySchema = z
  .object({
    status: z.nativeEnum(JobStatus).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

function serializeJob({ job, queueName }: JobWithQueue): JobResponse {
  return {
    id: job.id,
    status: job.status as JobStatus,
    type: job.type,
    queue: queueName,
    priority: job.priority as JobPriority,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    scheduledAt: job.scheduledAt.toISOString(),
    result: job.result as Record<string, unknown> | null,
    error: job.error as Record<string, unknown> | null,
  };
}

function sendMissingJob(reply: FastifyReply, id: string): FastifyReply {
  return reply.status(404).send({
    error: 'Not Found',
    message: `Job ${id} not found`,
    statusCode: 404,
    timestamp: new Date().toISOString(),
  });
}

/** Job submission, tenant-scoped reads, cancellation, and manual retry. */
export function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SubmitJobRequest }>('/', async (request, reply) => {
    const validated = submitJobSchema.parse(request.body);
    const queue = await getQueueByName(validated.queue);

    if (!queue?.isActive) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Queue ${validated.queue} not found or inactive`,
        statusCode: 404,
        timestamp: new Date().toISOString(),
      });
    }

    const userId = request.user!.id;
    const jobData = {
      userId,
      queueId: queue.id,
      type: validated.type,
      payload: validated.payload,
      priority: validated.priority,
      maxAttempts: validated.maxAttempts ?? queue.maxRetryAttempts,
      timeoutMs: validated.timeoutMs ?? queue.defaultTimeoutMs,
      scheduledAt: validated.scheduledAt,
      metadata: validated.metadata ?? null,
      tags: validated.tags ?? null,
    };

    let result: JobWithQueue;
    let disposition: 'created' | 'replayed' = 'created';

    if (request.idempotencyKey && request.requestHash) {
      const idempotent = await createJobWithIdempotency(
        jobData,
        userId,
        request.idempotencyKey,
        request.requestHash
      );
      result = idempotent;
      disposition = idempotent.disposition;
      void reply.header('Idempotency-Key', request.idempotencyKey);
      if (disposition === 'replayed') {
        void reply.header('X-Idempotent-Replay', 'true');
      }
    } else {
      const job = await createJob(jobData);
      result = { job, queueName: queue.name };
    }

    logger.info(
      { jobId: result.job.id, type: result.job.type, queue: result.queueName },
      disposition === 'created' ? 'Job created' : 'Job replayed'
    );
    return reply
      .status(disposition === 'created' ? 201 : 200)
      .send(serializeJob(result));
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = jobIdParamsSchema.parse(request.params);
    const result = await getJobForUser(id, request.user!.id);
    if (!result) return sendMissingJob(reply, id);
    return reply.send(serializeJob(result));
  });

  app.get<{
    Querystring: {
      status?: string;
      limit?: string | number;
      offset?: string | number;
    };
  }>('/', async (request, reply) => {
    const query = listJobsQuerySchema.parse(request.query);
    const result = await getJobsForUser(request.user!.id, query);

    return reply.send({
      data: result.jobs.map(serializeJob),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: result.total,
      },
    });
  });

  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = jobIdParamsSchema.parse(request.params);
    const result = await cancelJobForUser(id, request.user!.id);
    if (!result) return sendMissingJob(reply, id);

    logger.info(
      { jobId: id, newStatus: result.job.status },
      'Job cancellation persisted'
    );
    return reply.send(serializeJob(result));
  });

  app.post<{ Params: { id: string } }>('/:id/retry', async (request, reply) => {
    const { id } = jobIdParamsSchema.parse(request.params);
    const audit = {
      actorUserId: request.user!.id,
      actorRole: request.user!.role,
      requestId: request.id,
    };
    const result = await retryDeadLetteredJobForUser(
      id,
      request.user!.id,
      audit
    );
    if (!result) {
      await recordOperationalAudit({
        ...audit,
        action: 'job.manual_retry',
        targetType: 'job',
        targetId: id,
        outcome: 'REJECTED',
        statusCode: 404,
        metadata: { reason: 'not_found_or_not_owned' },
      });
      return sendMissingJob(reply, id);
    }
    if (result.kind === 'CONFLICT') {
      return reply.status(409).send({
        error: 'Conflict',
        message: result.message,
        statusCode: 409,
        timestamp: new Date().toISOString(),
      });
    }

    const { replacement } = result;

    logger.info(
      { originalJobId: id, replacementJobId: replacement.job.id },
      'Dead-lettered job manually retried'
    );
    return reply.status(201).send(serializeJob(replacement));
  });

  return Promise.resolve();
}
