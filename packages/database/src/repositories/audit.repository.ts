import type { AuditAction, AuditOutcome } from '@taskflow/types';
import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '../client';
import {
  type NewOperationalAuditLog,
  type OperationalAuditLog,
  operationalAuditLogs,
} from '../schema';

export type DatabaseTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export interface OperationAuditContext {
  actorUserId: string;
  actorRole: 'admin' | 'user';
  requestId: string;
}

export interface OperationalAuditInput extends OperationAuditContext {
  action: AuditAction;
  targetType: 'queue' | 'worker' | 'job';
  targetId: string;
  outcome: AuditOutcome;
  statusCode: number;
  metadata?: Record<string, unknown> | null;
}

export async function insertOperationalAudit(
  tx: DatabaseTransaction,
  input: OperationalAuditInput
): Promise<OperationalAuditLog> {
  const [record] = await tx
    .insert(operationalAuditLogs)
    .values(input satisfies NewOperationalAuditLog)
    .returning();
  if (!record) throw new Error('Failed to persist operational audit record');
  return record;
}

/** Record an outcome that has no associated state mutation, such as 404. */
export async function recordOperationalAudit(
  input: OperationalAuditInput
): Promise<OperationalAuditLog> {
  return db.transaction((tx) => insertOperationalAudit(tx, input));
}

export interface ListOperationalAuditOptions {
  actorUserId?: string;
  action?: AuditAction;
  outcome?: AuditOutcome;
  limit: number;
  offset: number;
}

/**
 * List operational audit records and total count in one transaction.
 * Runs under PostgreSQL's default READ COMMITTED isolation level.
 */
export async function listOperationalAudit(
  options: ListOperationalAuditOptions
): Promise<{ records: OperationalAuditLog[]; total: number }> {
  const predicates = [];
  if (options.actorUserId) {
    predicates.push(eq(operationalAuditLogs.actorUserId, options.actorUserId));
  }
  if (options.action) {
    predicates.push(eq(operationalAuditLogs.action, options.action));
  }
  if (options.outcome) {
    predicates.push(eq(operationalAuditLogs.outcome, options.outcome));
  }
  const predicate = predicates.length > 0 ? and(...predicates) : undefined;

  return db.transaction(async (tx) => {
    const [records, [count]] = await Promise.all([
      tx
        .select()
        .from(operationalAuditLogs)
        .where(predicate)
        .orderBy(
          desc(operationalAuditLogs.createdAt),
          desc(operationalAuditLogs.id)
        )
        .limit(options.limit)
        .offset(options.offset),
      tx
        .select({ total: sql<number>`COUNT(*)::integer` })
        .from(operationalAuditLogs)
        .where(predicate),
    ]);
    return { records, total: count?.total ?? 0 };
  });
}
