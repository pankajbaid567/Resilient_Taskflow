import {
  JOB_STATUS_VALUES,
  JobStatus,
  MAX_JOB_ATTEMPTS,
  MAX_JOB_TIMEOUT_MS,
} from '@taskflow/types';
import { sql } from 'drizzle-orm';
import {
  check,
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
    workerId: uuid('worker_id').references(() => workers.id, {
      onDelete: 'set null',
    }),
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

    // Monotonic sequence allocated once for every lifecycle event.
    eventSequence: integer('event_sequence').notNull().default(0),
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
    eventSequenceCheck: check(
      'jobs_event_sequence_non_negative',
      sql`${table.eventSequence} >= 0`
    ),
    attemptsNonNegativeCheck: check(
      'jobs_attempts_non_negative',
      sql`${table.attempts} >= 0`
    ),
    maxAttemptsPositiveCheck: check(
      'jobs_max_attempts_positive',
      sql`${table.maxAttempts} > 0`
    ),
    maxAttemptsBoundedCheck: check(
      'jobs_max_attempts_bounded',
      sql`${table.maxAttempts} <= ${sql.raw(String(MAX_JOB_ATTEMPTS))}`
    ),
    attemptsWithinBudgetCheck: check(
      'jobs_attempts_within_budget',
      sql`${table.attempts} <= ${table.maxAttempts}`
    ),
    timeoutPositiveCheck: check(
      'jobs_timeout_positive',
      sql`${table.timeoutMs} > 0`
    ),
    timeoutBoundedCheck: check(
      'jobs_timeout_bounded',
      sql`${table.timeoutMs} <= ${sql.raw(String(MAX_JOB_TIMEOUT_MS))}`
    ),
    versionPositiveCheck: check(
      'jobs_version_positive',
      sql`${table.version} > 0`
    ),
    leaseStateCheck: check(
      'jobs_lease_state_consistent',
      sql`(
        (${table.status} IN ('PROCESSING', 'CANCEL_REQUESTED')
          AND ${table.workerId} IS NOT NULL
          AND ${table.leaseId} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL)
        OR
        (${table.status} NOT IN ('PROCESSING', 'CANCEL_REQUESTED')
          AND ${table.leaseId} IS NULL
          AND ${table.leaseExpiresAt} IS NULL)
      )`
    ),

    // Composite indexes for worker queries
    queueStatusPriorityIdx: index('idx_jobs_queue_status_priority').on(
      table.queueId,
      table.status,
      table.priority,
      table.createdAt
    ),
    // Partial, GIN, per-column ordered, expression, and INCLUDE indexes are
    // intentionally migration-owned: drizzle-kit 0.20 drops those attributes
    // when reading Drizzle 0.29 declarations. Migrations 0002 and 0006 are the
    // authority for every idx_jobs_* performance index not declared above.
  })
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
