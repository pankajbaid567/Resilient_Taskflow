
import {
  cancelJob,
  createJob as createJobInDb,
  createJobWithIdempotency,
  getJobById,
  getJobsByUserId,
  getQueueByName,
  updateJobStatus,
} from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { enqueueJob } from '@taskflow/queue';
import {
  JobResponse,
  JobPriority,
  JobStatus,
  submitJobSchema,
  SubmitJobRequest,
} from '@taskflow/types';
import { FastifyInstance } from 'fastify';

const logger = createLogger({ component: 'JobRoutes' });

/**
 * Job Routes
 *
 * Handles job submission, retrieval, and cancellation.
 */
export function jobRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Submit a new job
   * POST /api/v1/jobs
   */
  app.post<{ Body: SubmitJobRequest }>('/', async (request, reply) => {
    // Validate request body
    const validatedData = submitJobSchema.parse(request.body);

    const {
      type,
      payload,
      queue = 'default',
      priority = 'NORMAL',
      maxAttempts,
      timeoutMs,
      scheduledAt,
      metadata,
      tags,
    } = validatedData;

    try {
      // Get user from authentication
      const userId = request.user!.id;

      const queueRecord = await getQueueByName(queue);

      if (!queueRecord || !queueRecord.isActive) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Queue ${queue} not found or inactive`,
          statusCode: 404,
          timestamp: new Date().toISOString(),
        });
      }

      const queueId = queueRecord.id;
      const jobMetadata = {
        ...(metadata || {}),
        queue,
      };

      // Create job (with idempotency if key provided)
      let job;

      if (request.idempotencyKey && request.requestHash) {
        // Create job with idempotency protection
        job = await createJobWithIdempotency(
          {
            userId,
            queueId,
            type,
            payload,
            priority,
            status: 'CREATED',
            attempts: 0,
            maxAttempts: maxAttempts || 3,
            timeoutMs: timeoutMs || 30000,
            scheduledAt: scheduledAt || new Date(),
            metadata: jobMetadata,
            tags: tags || null,
            leaseId: null,
            leaseExpiresAt: null,
            workerId: null,
            result: null,
            error: null,
            createdAt: new Date(),
            startedAt: null,
            completedAt: null,
            failedAt: null,
            version: 1,
          },
          userId,
          request.idempotencyKey,
          request.requestHash,
          86400000 // 24 hours
        );

        logger.info('Job created with idempotency', {
          jobId: job.id,
          type,
          queue,
          idempotencyKey: request.idempotencyKey,
        });
      } else {
        // Create job without idempotency
        job = await createJobInDb({
          userId,
          queueId,
          type,
          payload,
          priority,
          status: 'CREATED',
          attempts: 0,
          maxAttempts: maxAttempts || 3,
          timeoutMs: timeoutMs || 30000,
          scheduledAt: scheduledAt || new Date(),
          metadata: jobMetadata,
          tags: tags || null,
          leaseId: null,
          leaseExpiresAt: null,
          workerId: null,
          result: null,
          error: null,
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
          failedAt: null,
          version: 1,
        });

        logger.info('Job created', { jobId: job.id, type, queue });
      }

      // Enqueue to Redis if scheduled for now
      if (new Date(job.scheduledAt) <= new Date()) {
        try {
          await enqueueJob(job.id, queue, 1);
          job = await updateJobStatus(job.id, JobStatus.QUEUED);

          logger.info('Job enqueued', { jobId: job.id, queue });
        } catch (error) {
          logger.error('Failed to enqueue job', { jobId: job.id, error });
          // Job remains in CREATED state, sweeper will recover
        }
      }

      // Build response
      const response: JobResponse = {
        id: job.id,
        status: job.status as JobStatus,
        type: job.type,
        queue,
        priority: job.priority as JobPriority,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString() || null,
        completedAt: job.completedAt?.toISOString() || null,
        scheduledAt: job.scheduledAt.toISOString(),
        result: job.result as Record<string, unknown> | null,
        error: job.error as Record<string, unknown> | null,
      };

      // Set idempotency header if key was provided
      if (request.idempotencyKey) {
        void reply.header('Idempotency-Key', request.idempotencyKey);
      }

      return reply.status(201).send(response);
    } catch (error) {
      logger.error('Failed to create job', { error });
      throw error;
    }
  });

  /**
   * Get job by ID
   * GET /api/v1/jobs/:id
   */
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    const job = await getJobById(id);

    if (!job) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Job ${id} not found`,
        statusCode: 404,
        timestamp: new Date().toISOString(),
      });
    }

    // Check if user owns this job (authorization)
    if (job.userId !== request.user!.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to access this job',
        statusCode: 403,
        timestamp: new Date().toISOString(),
      });
    }

    const response: JobResponse = {
      id: job.id,
      status: job.status as JobStatus,
      type: job.type,
      queue: 'default', // TODO: Get from queue relation
      priority: job.priority as JobPriority,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
      scheduledAt: job.scheduledAt.toISOString(),
      result: job.result as Record<string, unknown> | null,
      error: job.error as Record<string, unknown> | null,
    };

    return reply.send(response);
  });

  /**
   * List jobs for current user
   * GET /api/v1/jobs
   */
  app.get<{
    Querystring: {
      status?: JobStatus;
      limit?: number;
      offset?: number;
    };
  }>('/', async (request, reply) => {
    const { status, limit = 50, offset = 0 } = request.query;

    // Get user from authentication
    const userId = request.user!.id;

    const jobs = await getJobsByUserId(userId, {
      status,
      limit: Math.min(limit, 100), // Cap at 100
      offset,
    });

    const response = jobs.map((job) => ({
      id: job.id,
      status: job.status as JobStatus,
      type: job.type,
      queue: 'default',
      priority: job.priority as JobPriority,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
      scheduledAt: job.scheduledAt.toISOString(),
      result: job.result as Record<string, unknown> | null,
      error: job.error as Record<string, unknown> | null,
    }));

    return reply.send({
      data: response,
      pagination: {
        limit,
        offset,
        total: response.length, // TODO: Get actual count
      },
    });
  });

  /**
   * Cancel a job
   * DELETE /api/v1/jobs/:id
   */
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    // Check if job exists
    const job = await getJobById(id);

    if (!job) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Job ${id} not found`,
        statusCode: 404,
        timestamp: new Date().toISOString(),
      });
    }

    // Check if user owns this job (authorization)
    if (job.userId !== request.user!.id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to cancel this job',
        statusCode: 403,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const cancelled = await cancelJob(id);

      logger.info('Job cancelled', {
        jobId: id,
        previousStatus: job.status,
        newStatus: cancelled.status,
      });

      const response: JobResponse = {
        id: cancelled.id,
        status: cancelled.status as JobStatus,
        type: cancelled.type,
        queue: 'default',
        priority: cancelled.priority as JobPriority,
        attempts: cancelled.attempts,
        maxAttempts: cancelled.maxAttempts,
        createdAt: cancelled.createdAt.toISOString(),
        startedAt: cancelled.startedAt?.toISOString() || null,
        completedAt: cancelled.completedAt?.toISOString() || null,
        scheduledAt: cancelled.scheduledAt.toISOString(),
        result: cancelled.result as Record<string, unknown> | null,
        error: cancelled.error as Record<string, unknown> | null,
      };

      return reply.send(response);
    } catch (error) {
      logger.error('Failed to cancel job', { jobId: id, error });
      throw error;
    }
  });

  /**
   * Retry a failed job
   * POST /api/v1/jobs/:id/retry
   */
  app.post<{ Params: { id: string } }>(
    '/:id/retry',
    async (_request, reply) => {
      // TODO: Implement retry logic
      // - Check if job is in FAILED or DEAD_LETTERED state
      // - Create new job or reset existing job
      // - Re-enqueue to Redis

      return reply.status(501).send({
        error: 'Not Implemented',
        message: 'Job retry not yet implemented',
        statusCode: 501,
        timestamp: new Date().toISOString(),
      });
    }
  );

  return Promise.resolve();
}
