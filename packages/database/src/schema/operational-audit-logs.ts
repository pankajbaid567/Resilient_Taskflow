import { AUDIT_ACTION_VALUES, AUDIT_OUTCOME_VALUES } from '@taskflow/types';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** Application append-only, payload-free evidence for operational control requests. */
export const operationalAuditLogs = pgTable(
  'operational_audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id').notNull(),
    actorRole: varchar('actor_role', { length: 16 }).notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: varchar('target_id', { length: 255 }).notNull(),
    requestId: varchar('request_id', { length: 255 }).notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    statusCode: integer('status_code').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    actorCreatedIdx: index('idx_operational_audit_actor_created').on(
      table.actorUserId,
      table.createdAt
    ),
    actionCreatedIdx: index('idx_operational_audit_action_created').on(
      table.action,
      table.createdAt
    ),
    targetIdx: index('idx_operational_audit_target').on(
      table.targetType,
      table.targetId,
      table.createdAt
    ),
    actionCheck: check(
      'operational_audit_action_valid',
      sql`${table.action} IN (${sql.join(
        AUDIT_ACTION_VALUES.map((value) => sql`${value}`),
        sql`, `
      )})`
    ),
    outcomeCheck: check(
      'operational_audit_outcome_valid',
      sql`${table.outcome} IN (${sql.join(
        AUDIT_OUTCOME_VALUES.map((value) => sql`${value}`),
        sql`, `
      )})`
    ),
    roleCheck: check(
      'operational_audit_actor_role_valid',
      sql`${table.actorRole} IN ('admin', 'user')`
    ),
    statusCodeCheck: check(
      'operational_audit_status_code_valid',
      sql`${table.statusCode} BETWEEN 100 AND 599`
    ),
  })
);

export type OperationalAuditLog = typeof operationalAuditLogs.$inferSelect;
export type NewOperationalAuditLog = typeof operationalAuditLogs.$inferInsert;
