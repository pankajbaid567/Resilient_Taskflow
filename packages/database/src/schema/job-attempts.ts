import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { jobs, jobStatusEnum } from './jobs';
import { workers } from './workers';

/**
 * Job Attempts Table
 *
 * Records every execution attempt for debugging and analytics.
 */
export const jobAttempts = pgTable(
  'job_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    // Attempt Info
    attemptNumber: integer('attempt_number').notNull(),

    // Execution
    workerId: uuid('worker_id').references(() => workers.id),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    // Result
    status: jobStatusEnum('status').notNull(),
    error: jsonb('error'),
    errorMessage: text('error_message'),
    stackTrace: text('stack_trace'),

    // Context
    metadata: jsonb('metadata'),
  },
  (table) => ({
    jobAttemptUnique: unique('job_attempts_job_attempt_unique').on(
      table.jobId,
      table.attemptNumber
    ),
    jobIdIdx: index('idx_job_attempts_job_id').on(
      table.jobId,
      table.attemptNumber
    ),
    workerIdIdx: index('idx_job_attempts_worker_id').on(table.workerId),
    startedAtIdx: index('idx_job_attempts_started_at').on(table.startedAt),
    statusIdx: index('idx_job_attempts_status').on(table.status),
  })
);

export type JobAttempt = typeof jobAttempts.$inferSelect;
export type NewJobAttempt = typeof jobAttempts.$inferInsert;
