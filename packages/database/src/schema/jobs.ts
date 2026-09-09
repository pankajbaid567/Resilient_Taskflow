import { JOB_STATUS_VALUES, JobStatus } from '@taskflow/types';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';


import { queues } from './queues';
import { users } from './users';
import { workers } from './workers';

/**
 * Job Status Enum
 */
export const jobStatusEnum = pgEnum('job_status', JOB_STATUS_VALUES);

/**
 * Job Priority Enum
 */
export const jobPriorityEnum = pgEnum('job_priority', [
  'CRITICAL',
  'HIGH',
  'NORMAL',
  'LOW',
]);

/**
 * Jobs Table
 *
 * Core job records with full lifecycle state.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Ownership
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id),

    // Job Definition
    type: varchar('type', { length: 255 }).notNull(),
    payload: jsonb('payload').notNull(),
    priority: jobPriorityEnum('priority').notNull().default('NORMAL'),

    // Status
    status: jobStatusEnum('status').notNull().default(JobStatus.CREATED),

    // Retry Configuration
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),

    // Timing
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),

    // Worker Lease
    workerId: uuid('worker_id').references(() => workers.id),
    leaseId: uuid('lease_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    // Result
    result: jsonb('result'),
    error: jsonb('error'),

    // Metadata
    metadata: jsonb('metadata'),
    tags: varchar('tags', { length: 255 }).array(),

    // Versioning (for optimistic locking)
    version: integer('version').notNull().default(1),
  },
  (table) => ({
    // Indexes for common queries
    userIdIdx: index('idx_jobs_user_id').on(table.userId),
    queueIdIdx: index('idx_jobs_queue_id').on(table.queueId),
    statusIdx: index('idx_jobs_status').on(table.status),
    typeIdx: index('idx_jobs_type').on(table.type),
    scheduledAtIdx: index('idx_jobs_scheduled_at').on(table.scheduledAt),
    leaseExpiresAtIdx: index('idx_jobs_lease_expires_at').on(
      table.leaseExpiresAt
    ),
    createdAtIdx: index('idx_jobs_created_at').on(table.createdAt),

    // Composite indexes for worker queries
    queueStatusPriorityIdx: index('idx_jobs_queue_status_priority').on(
      table.queueId,
      table.status,
      table.priority,
      table.createdAt
    ),
  })
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
