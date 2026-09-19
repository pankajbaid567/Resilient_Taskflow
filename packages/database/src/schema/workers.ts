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

/**
 * Worker Status Enum
 */
export const workerStatusEnum = pgEnum('worker_status', [
  'STARTING',
  'ACTIVE',
  'STOPPING',
  'STOPPED',
  'FAILED',
]);

/**
 * Workers Table
 *
 * Tracks registered workers and their health status.
 */
export const workers = pgTable(
  'workers',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Identity
    workerName: varchar('worker_name', { length: 255 }).notNull(),
    hostname: varchar('hostname', { length: 255 }).notNull(),
    processId: integer('process_id').notNull(),

    // Configuration
    concurrency: integer('concurrency').notNull().default(10),
    queues: varchar('queues', { length: 255 }).array().notNull(),

    // Status
    status: workerStatusEnum('status').notNull().default('STARTING'),
    currentJobCount: integer('current_job_count').notNull().default(0),

    // Health
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),

    // Metrics
    totalJobsProcessed: integer('total_jobs_processed').notNull().default(0),
    totalJobsSucceeded: integer('total_jobs_succeeded').notNull().default(0),
    totalJobsFailed: integer('total_jobs_failed').notNull().default(0),

    // Metadata
    version: varchar('version', { length: 50 }),
    metadata: jsonb('metadata'),
  },
  (table) => ({
    statusIdx: index('idx_workers_status').on(table.status),
    lastHeartbeatIdx: index('idx_workers_last_heartbeat').on(
      table.lastHeartbeatAt
    ),
    hostnameIdx: index('idx_workers_hostname').on(table.hostname),
    // idx_workers_stale and idx_workers_active_queues are partial/GIN indexes
    // owned by migration 0002; see the compatibility note in jobs.ts.
    processIdPositiveCheck: check(
      'workers_process_id_positive',
      sql`${table.processId} > 0`
    ),
    concurrencyPositiveCheck: check(
      'workers_concurrency_positive',
      sql`${table.concurrency} > 0`
    ),
    queuesNonEmptyCheck: check(
      'workers_queues_non_empty',
      sql`cardinality(${table.queues}) > 0`
    ),
    currentJobsNonNegativeCheck: check(
      'workers_current_job_count_non_negative',
      sql`${table.currentJobCount} >= 0`
    ),
    totalsNonNegativeCheck: check(
      'workers_totals_non_negative',
      sql`${table.totalJobsProcessed} >= 0
        AND ${table.totalJobsSucceeded} >= 0
        AND ${table.totalJobsFailed} >= 0`
    ),
  })
);

export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
