import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { jobs } from './jobs';

/**
 * Job Deliveries Table (Transactional Outbox)
 *
 * Each row represents one intended XADD for a job. Created in the same
 * transaction that sets job status to QUEUED, ensuring no QUEUED job
 * ever lacks a delivery intent. The Dispatcher claims rows with
 * FOR UPDATE SKIP LOCKED, writes to Redis, and records the outcome.
 *
 * Status lifecycle: PENDING → PUBLISHED | FAILED
 */
export const jobDeliveries = pgTable(
  'job_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // FK to the job being delivered
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    // Queue name resolved from the queues table at creation time,
    // so the dispatcher never reads queue from JSON metadata.
    queueName: text('queue_name').notNull(),

    // Producer-supplied delivery hint encoded in the Redis envelope. The
    // authoritative execution count is jobs.attempts. Each retry gets a unique
    // successor row with attempt = jobs.attempts + 1.
    attempt: integer('attempt').notNull().default(1),

    // The dispatcher must not claim this row before its durable due time.
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),

    // PENDING | PUBLISHED | FAILED
    status: text('status').notNull().default('PENDING'),

    // Set after successful XADD
    redisMessageId: text('redis_message_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    // Concurrency fence: which dispatcher instance has claimed this row
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),

    // Dispatch priority: 4 CRITICAL .. 1 LOW, computed by the database
    // function job_priority_rank() from the job's priority. Higher rows are
    // claimed first, so backlog order honours priority (migration 0010).
    priorityRank: smallint('priority_rank').notNull().default(2),

    // Failure details
    error: text('error'),
    retryCount: integer('retry_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    jobAttemptUnique: unique('job_deliveries_job_id_attempt_key').on(
      table.jobId,
      table.attempt
    ),
    pendingIdx: index('idx_job_deliveries_pending')
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.status} = 'PENDING'`),
    // idx_job_deliveries_pending_priority (queue_name, priority_rank DESC,
    // available_at, created_at) WHERE status = 'PENDING' is migration-owned
    // (0010): drizzle-kit 0.20 cannot express per-column ordering.
    publishedJobIdx: index('idx_job_deliveries_published_job')
      .on(table.jobId)
      .where(sql`${table.status} = 'PUBLISHED'`),
  })
);

export type JobDelivery = typeof jobDeliveries.$inferSelect;
export type NewJobDelivery = typeof jobDeliveries.$inferInsert;
