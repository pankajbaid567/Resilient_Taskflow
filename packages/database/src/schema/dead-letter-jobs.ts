import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { jobs } from './jobs';
import { queues } from './queues';
import { users } from './users';

/**
 * Dead Letter Jobs Table
 *
 * Jobs that have permanently failed after max retry attempts.
 */
export const deadLetterJobs = pgTable(
  'dead_letter_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Original Job Reference
    originalJobId: uuid('original_job_id').notNull().unique(),

    // Job Data (snapshot at failure)
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id),
    type: varchar('type', { length: 255 }).notNull(),
    payload: jsonb('payload').notNull(),

    // Failure Info
    attempts: integer('attempts').notNull(),
    lastError: jsonb('last_error'),
    lastErrorMessage: text('last_error_message'),

    // Timing
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull(),

    // Resolution
    requeued: boolean('requeued').notNull().default(false),
    requeuedAt: timestamp('requeued_at', { withTimezone: true }),
    requeuedJobId: uuid('requeued_job_id').references(() => jobs.id),

    // Metadata
    metadata: jsonb('metadata'),
  },
  (table) => ({
    userIdIdx: index('idx_dead_letter_jobs_user_id').on(table.userId),
    queueIdIdx: index('idx_dead_letter_jobs_queue_id').on(table.queueId),
    createdAtIdx: index('idx_dead_letter_jobs_created_at').on(table.createdAt),
    requeuedIdx: index('idx_dead_letter_jobs_requeued').on(table.requeued),
    // idx_dead_letter_jobs_queue_created orders only created_at DESC;
    // migrations/0002_performance_indexes.sql owns that raw definition.
  })
);

export type DeadLetterJob = typeof deadLetterJobs.$inferSelect;
export type NewDeadLetterJob = typeof deadLetterJobs.$inferInsert;
