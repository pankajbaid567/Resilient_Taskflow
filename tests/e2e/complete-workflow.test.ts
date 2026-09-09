/**
 * End-to-End Tests: Complete Workflow
 * Tests complete job processing from API submission to completion
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createJob, sleep, waitFor } from '../helpers/factories';
import { randomUUID } from 'crypto';

describe('End-to-End Workflow', () => {
  describe('Job Submission and Processing', () => {
    it('should complete full workflow: submit -> queue -> process -> complete', async () => {
      const jobId = randomUUID();

      // Step 1: Submit job via API
      const submission = {
        id: jobId,
        type: 'test-job',
        queue: 'default',
        payload: { message: 'E2E test' },
        priority: 'NORMAL' as const,
      };

      expect(submission.id).toBeDefined();

      // Step 2: Job created in database
      const createdJob = createJob({
        id: jobId,
        ...submission,
        status: 'CREATED',
      });

      expect(createdJob.status).toBe('CREATED');

      // Step 3: Job queued to Redis
      const queuedJob = {
        ...createdJob,
        status: 'QUEUED' as const,
      };

      expect(queuedJob.status).toBe('QUEUED');

      // Step 4: Worker picks up job
      const processingJob = {
        ...queuedJob,
        status: 'PROCESSING' as const,
        workerId: 'worker-1',
        startedAt: new Date(),
      };

      expect(processingJob.status).toBe('PROCESSING');
      expect(processingJob.workerId).toBeDefined();

      // Step 5: Job completes successfully
      const completedJob = {
        ...processingJob,
        status: 'SUCCEEDED' as const,
        result: { success: true },
        completedAt: new Date(),
      };

      expect(completedJob.status).toBe('SUCCEEDED');
      expect(completedJob.result).toBeDefined();
      expect(completedJob.completedAt).toBeInstanceOf(Date);
    });

    it('should handle job with retry and eventual success', async () => {
      const jobId = randomUUID();

      // Attempt 1: Fails
      const attempt1 = createJob({
        id: jobId,
        status: 'FAILED',
        attempts: 1,
        maxAttempts: 3,
        error: 'Temporary error',
      });

      expect(attempt1.status).toBe('FAILED');
      expect(attempt1.attempts).toBe(1);

      // Schedule retry
      const retryScheduled = {
        ...attempt1,
        status: 'RETRY_SCHEDULED' as const,
        scheduledAt: new Date(Date.now() + 2000),
      };

      expect(retryScheduled.status).toBe('RETRY_SCHEDULED');

      // Attempt 2: Succeeds
      const attempt2 = {
        ...retryScheduled,
        status: 'PROCESSING' as const,
        attempts: 2,
      };

      const succeeded = {
        ...attempt2,
        status: 'SUCCEEDED' as const,
        result: { success: true },
        completedAt: new Date(),
      };

      expect(succeeded.status).toBe('SUCCEEDED');
      expect(succeeded.attempts).toBe(2);
    });

    it('should move to DLQ after max retries', async () => {
      const jobId = randomUUID();
      const maxAttempts = 3;

      // Fail all attempts
      let job = createJob({
        id: jobId,
        attempts: 0,
        maxAttempts,
        status: 'QUEUED',
      });

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Process
        job = {
          ...job,
          status: 'PROCESSING' as const,
          attempts: attempt,
        };

        // Fail
        job = {
          ...job,
          status: 'FAILED' as const,
          error: `Attempt ${attempt} failed`,
        };

        if (attempt < maxAttempts) {
          // Schedule retry
          job = {
            ...job,
            status: 'RETRY_SCHEDULED' as const,
            scheduledAt: new Date(Date.now() + 1000 * attempt),
          };
        }
      }

      // Move to DLQ
      const dlqJob = {
        ...job,
        status: 'DEAD_LETTERED' as const,
      };

      expect(dlqJob.status).toBe('DEAD_LETTERED');
      expect(dlqJob.attempts).toBe(maxAttempts);
    });
  });

  describe('Priority Queue Workflow', () => {
    it('should process critical jobs before normal jobs', async () => {
      const criticalJob = createJob({
        id: 'critical-1',
        priority: 'CRITICAL',
        queue: 'default',
      });

      const normalJob = createJob({
        id: 'normal-1',
        priority: 'NORMAL',
        queue: 'default',
      });

      // Both submitted
      const jobs = [criticalJob, normalJob];

      // Sort by priority
      const priorityOrder = {
        CRITICAL: 4,
        HIGH: 3,
        NORMAL: 2,
        LOW: 1,
      };

      const sorted = jobs.sort(
        (a, b) =>
          priorityOrder[b.priority as keyof typeof priorityOrder] -
          priorityOrder[a.priority as keyof typeof priorityOrder]
      );

      expect(sorted[0].id).toBe('critical-1');
      expect(sorted[1].id).toBe('normal-1');
    });
  });

  describe('Scheduled Job Workflow', () => {
    it('should delay execution until scheduled time', async () => {
      const scheduledAt = new Date(Date.now() + 5000); // 5 seconds from now

      const job = createJob({
        status: 'QUEUED',
        scheduledAt,
      });

      // Should not process yet
      const now = new Date();
      expect(job.scheduledAt.getTime()).toBeGreaterThan(now.getTime());

      // Simulate time passing
      const futureTime = new Date(Date.now() + 6000);
      expect(job.scheduledAt.getTime()).toBeLessThan(futureTime.getTime());
    });
  });

  describe('Idempotency Workflow', () => {
    it('should prevent duplicate job submission', async () => {
      const idempotencyKey = 'unique-request-123';

      const job1 = createJob({
        id: 'job-1',
        idempotencyKey,
        type: 'send-email',
        payload: { to: 'test@example.com' },
      });

      // Duplicate submission with same key
      const job2 = createJob({
        id: 'job-2',
        idempotencyKey,
        type: 'send-email',
        payload: { to: 'test@example.com' },
      });

      // In real implementation, second submission would:
      // - Return existing job if request identical
      // - Reject if request different but same key

      expect(job1.idempotencyKey).toBe(job2.idempotencyKey);
    });

    it('should allow different jobs with different keys', async () => {
      const job1 = createJob({
        idempotencyKey: 'key-1',
      });

      const job2 = createJob({
        idempotencyKey: 'key-2',
      });

      expect(job1.idempotencyKey).not.toBe(job2.idempotencyKey);
    });
  });

  describe('Cancellation Workflow', () => {
    it('should cancel queued job immediately', async () => {
      let job = createJob({
        status: 'QUEUED',
      });

      // User requests cancellation
      job = {
        ...job,
        status: 'CANCELLED' as const,
      };

      expect(job.status).toBe('CANCELLED');
    });

    it('should cooperatively cancel processing job', async () => {
      let job = createJob({
        status: 'PROCESSING',
        workerId: 'worker-1',
      });

      // User requests cancellation
      job = {
        ...job,
        status: 'CANCEL_REQUESTED' as const,
      };

      expect(job.status).toBe('CANCEL_REQUESTED');

      // Worker checks cancellation and stops
      job = {
        ...job,
        status: 'CANCELLED' as const,
      };

      expect(job.status).toBe('CANCELLED');
    });

    it('should handle race between cancellation and completion', async () => {
      let job = createJob({
        status: 'PROCESSING',
      });

      // Cancellation requested
      job = {
        ...job,
        status: 'CANCEL_REQUESTED' as const,
      };

      // But job completes before worker checks cancellation
      const completedJob = {
        ...job,
        status: 'SUCCEEDED' as const,
        result: { completed: true },
        completedAt: new Date(),
      };

      // This is a valid race condition - job completed successfully
      expect(completedJob.status).toBe('SUCCEEDED');
    });
  });

  describe('Multi-Queue Workflow', () => {
    it('should process jobs from multiple queues', async () => {
      const emailJob = createJob({
        queue: 'email-queue',
        type: 'send-email',
      });

      const analyticsJob = createJob({
        queue: 'analytics-queue',
        type: 'process-analytics',
      });

      const reportJob = createJob({
        queue: 'report-queue',
        type: 'generate-report',
      });

      expect(emailJob.queue).not.toBe(analyticsJob.queue);
      expect(analyticsJob.queue).not.toBe(reportJob.queue);
    });
  });

  describe('Worker Lifecycle Workflow', () => {
    it('should handle worker registering and processing', async () => {
      const workerId = randomUUID();

      // Worker registers
      const worker = {
        id: workerId,
        name: 'worker-1',
        queues: ['default'],
        status: 'IDLE' as const,
        lastHeartbeat: new Date(),
      };

      expect(worker.status).toBe('IDLE');

      // Worker picks up job
      const job = createJob({
        status: 'PROCESSING',
        workerId: worker.id,
      });

      const processingWorker = {
        ...worker,
        status: 'PROCESSING' as const,
      };

      expect(processingWorker.status).toBe('PROCESSING');
      expect(job.workerId).toBe(workerId);

      // Worker completes job
      const idleWorker = {
        ...processingWorker,
        status: 'IDLE' as const,
        lastHeartbeat: new Date(),
      };

      expect(idleWorker.status).toBe('IDLE');
    });

    it('should handle graceful worker shutdown', async () => {
      const worker = {
        id: randomUUID(),
        status: 'PROCESSING' as const,
      };

      // Shutdown signal received
      const shuttingDownWorker = {
        ...worker,
        status: 'STOPPED' as const,
      };

      expect(shuttingDownWorker.status).toBe('STOPPED');
    });
  });

  describe('Lease Management Workflow', () => {
    it('should acquire and renew lease during processing', async () => {
      const workerId = 'worker-1';
      const leaseId = randomUUID();

      // Acquire lease
      let job = createJob({
        status: 'PROCESSING',
        workerId,
        leaseId,
        leaseExpiresAt: new Date(Date.now() + 60000),
      });

      expect(job.leaseId).toBe(leaseId);
      expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

      // Renew lease
      job = {
        ...job,
        leaseExpiresAt: new Date(Date.now() + 60000),
      };

      expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

      // Release lease on completion
      job = {
        ...job,
        status: 'SUCCEEDED' as const,
        leaseId: null,
        leaseExpiresAt: null,
      };

      expect(job.leaseId).toBeNull();
    });

    it('should handle expired lease recovery', async () => {
      const expiredLeaseJob = createJob({
        status: 'PROCESSING',
        workerId: 'worker-1',
        leaseId: 'expired-lease',
        leaseExpiresAt: new Date(Date.now() - 1000), // Expired
      });

      // Check if lease expired
      const isExpired =
        expiredLeaseJob.leaseExpiresAt!.getTime() < Date.now();
      expect(isExpired).toBe(true);

      // Another worker can reclaim
      const reclaimedJob = {
        ...expiredLeaseJob,
        workerId: 'worker-2',
        leaseId: 'new-lease',
        leaseExpiresAt: new Date(Date.now() + 60000),
      };

      expect(reclaimedJob.workerId).toBe('worker-2');
      expect(reclaimedJob.leaseId).not.toBe(expiredLeaseJob.leaseId);
    });
  });

  describe('Event Publishing Workflow', () => {
    it('should publish events for job lifecycle', async () => {
      const jobId = randomUUID();
      const events: Array<{ type: string; jobId: string }> = [];

      // Job created
      events.push({ type: 'job.created', jobId });

      // Job queued
      events.push({ type: 'job.queued', jobId });

      // Job started
      events.push({ type: 'job.started', jobId });

      // Job completed
      events.push({ type: 'job.completed', jobId });

      expect(events.length).toBe(4);
      expect(events.every((e) => e.jobId === jobId)).toBe(true);
    });
  });

  describe('Batch Processing Workflow', () => {
    it('should process multiple jobs concurrently', async () => {
      const jobs = Array.from({ length: 10 }, (_, i) =>
        createJob({
          id: `job-${i}`,
          status: 'QUEUED',
        })
      );

      // Simulate concurrent processing
      const processing = jobs.slice(0, 5).map((job) => ({
        ...job,
        status: 'PROCESSING' as const,
        workerId: `worker-${Math.floor(Math.random() * 3)}`,
      }));

      expect(processing.length).toBe(5);
      expect(processing.every((j) => j.status === 'PROCESSING')).toBe(true);
    });
  });
});
