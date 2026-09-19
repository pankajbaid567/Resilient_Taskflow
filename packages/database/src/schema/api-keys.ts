import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * Hashed API credentials. Plaintext keys are accepted only at the HTTP edge
 * and are never stored. Expiry, revocation, and user activation are all
 * checked for every authentication attempt.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_api_keys_user_id').on(table.userId),
    expiryIdx: index('idx_api_keys_expires_at').on(table.expiresAt),
    hashFormatCheck: check(
      'api_keys_hash_format',
      sql`${table.keyHash} ~ '^[a-f0-9]{64}$'`
    ),
    expiryAfterCreationCheck: check(
      'api_keys_expiry_after_creation',
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`
    ),
    revocationAfterCreationCheck: check(
      'api_keys_revocation_after_creation',
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`
    ),
  })
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
