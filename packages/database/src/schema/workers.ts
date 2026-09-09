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
  })
);

export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
