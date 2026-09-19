import {
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { jobs } from './jobs';
import { users } from './users';

/**
 * Idempotency Keys Table
 *
 * Prevents duplicate job submissions.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Key
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),

    // Reference
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    // Request fingerprint
    requestHash: varchar('request_hash', { length: 64 }).notNull(),

    // Timing
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    uniqueUserKey: unique('idempotency_keys_user_key_unique').on(
      table.userId,
      table.idempotencyKey
    ),
    expiresAtIdx: index('idx_idempotency_keys_expires').on(table.expiresAt),
    jobIdIdx: index('idx_idempotency_keys_job_id').on(table.jobId),
    activeLookupIdx: index('idx_idempotency_keys_active').on(
      table.userId,
      table.idempotencyKey,
      table.expiresAt
    ),
  })
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
