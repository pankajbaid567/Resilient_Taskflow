import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
export const jobDeliveries = pgTable('job_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),

  // FK to the job being delivered
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),

  // Queue name resolved from the queues table at creation time,
  // so the dispatcher never reads queue from JSON metadata.
  queueName: text('queue_name').notNull(),

  // Attempt number encoded in the Redis envelope
  attempt: integer('attempt').notNull().default(1),

  // PENDING | PUBLISHED | FAILED
  status: text('status').notNull().default('PENDING'),

  // Set after successful XADD
  redisMessageId: text('redis_message_id'),
  publishedAt: timestamp('published_at', { withTimezone: true }),

  // Concurrency fence: which dispatcher instance has claimed this row
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),

  // Failure details
  error: text('error'),
  retryCount: integer('retry_count').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type JobDelivery = typeof jobDeliveries.$inferSelect;
export type NewJobDelivery = typeof jobDeliveries.$inferInsert;
