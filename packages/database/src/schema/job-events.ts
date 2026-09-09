import {
  index,
  jsonb,
  pgTable,
  timestamp,
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
    fromStatus: jobStatusEnum('from_status'),
    toStatus: jobStatusEnum('to_status').notNull(),
    
    // Context
    workerId: uuid('worker_id').references(() => workers.id),
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
  })
);

export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
