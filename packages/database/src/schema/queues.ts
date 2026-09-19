import {
  MAX_JOB_ATTEMPTS,
  MAX_JOB_TIMEOUT_MS,
  QUEUE_NAME_PATTERN,
} from '@taskflow/types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
export const queues = pgTable(
  'queues',
  {
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
  },
  (table) => ({
    // idx_queues_active is a partial index owned by migration 0002.
    nameFormatCheck: check(
      'queues_name_format',
      sql`${table.name} ~ ${sql.raw(`'${QUEUE_NAME_PATTERN.source}'`)}`
    ),
    priorityPositiveCheck: check(
      'queues_priority_positive',
      sql`${table.priority} > 0`
    ),
    concurrencyPositiveCheck: check(
      'queues_concurrency_positive',
      sql`${table.concurrencyLimit} IS NULL OR ${table.concurrencyLimit} > 0`
    ),
    maxRetriesPositiveCheck: check(
      'queues_max_retry_attempts_positive',
      sql`${table.maxRetryAttempts} > 0`
    ),
    maxRetriesBoundedCheck: check(
      'queues_max_retry_attempts_bounded',
      sql`${table.maxRetryAttempts} <= ${sql.raw(String(MAX_JOB_ATTEMPTS))}`
    ),
    timeoutPositiveCheck: check(
      'queues_default_timeout_positive',
      sql`${table.defaultTimeoutMs} > 0`
    ),
    timeoutBoundedCheck: check(
      'queues_default_timeout_bounded',
      sql`${table.defaultTimeoutMs} <= ${sql.raw(String(MAX_JOB_TIMEOUT_MS))}`
    ),
    rateLimitPositiveCheck: check(
      'queues_rate_limit_positive',
      sql`${table.rateLimitPerMinute} IS NULL OR ${table.rateLimitPerMinute} > 0`
    ),
  })
);

export type Queue = typeof queues.$inferSelect;
export type NewQueue = typeof queues.$inferInsert;
