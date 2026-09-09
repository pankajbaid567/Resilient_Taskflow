import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Queues Table
 * 
 * Defines queue configurations and metadata.
 */
export const queues = pgTable('queues', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  description: text('description'),
  priority: integer('priority').notNull().default(5),
  concurrencyLimit: integer('concurrency_limit'),
  maxRetryAttempts: integer('max_retry_attempts').notNull().default(3),
  defaultTimeoutMs: integer('default_timeout_ms').notNull().default(30000),
  rateLimitPerMinute: integer('rate_limit_per_minute'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Queue = typeof queues.$inferSelect;
export type NewQueue = typeof queues.$inferInsert;
