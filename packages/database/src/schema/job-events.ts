import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { jobs, jobStatusEnum } from './jobs';
import { users } from './users';
import { workers } from './workers';

/**
 * Job Events Table
 *
 * Audit log of all job state transitions.
 */
export const jobEvents = pgTable(
  'job_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    // Event
    eventType: varchar('event_type', { length: 50 }).notNull(),
    sequence: integer('event_sequence').notNull(),
    fromStatus: jobStatusEnum('from_status'),
    toStatus: jobStatusEnum('to_status').notNull(),

    // Context
    workerId: uuid('worker_id').references(() => workers.id, {
      onDelete: 'set null',
    }),
    userId: uuid('user_id').references(() => users.id),

    // Timing
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Details
    metadata: jsonb('metadata'),
  },
  (table) => ({
    jobIdIdx: index('idx_job_events_job_id').on(table.jobId, table.createdAt),
    eventTypeIdx: index('idx_job_events_type').on(table.eventType),
    createdAtIdx: index('idx_job_events_created_at').on(table.createdAt),
    workerIdIdx: index('idx_job_events_worker_id').on(table.workerId),
    jobSequenceUnique: unique('job_events_job_sequence_unique').on(
      table.jobId,
      table.sequence
    ),
    eventSequenceCheck: check(
      'job_events_event_sequence_positive',
      sql`${table.sequence} > 0`
    ),
  })
);

export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
