import { asc, eq, sql } from 'drizzle-orm';

import { db } from '../client';
import { Queue, queues } from '../schema';

import {
  insertOperationalAudit,
  type OperationAuditContext,
} from './audit.repository';

export interface ListQueuesOptions {
  limit: number;
  offset: number;
}

export interface PaginatedQueues {
  queues: Queue[];
  total: number;
}

/** List queue configuration from PostgreSQL with an authoritative total. */
export async function listQueues(
  options: ListQueuesOptions
): Promise<PaginatedQueues> {
  return db.transaction(async (tx) => {
    const [queueRows, [countRow]] = await Promise.all([
      tx
        .select()
        .from(queues)
        .orderBy(asc(queues.name), asc(queues.id))
        .limit(options.limit)
        .offset(options.offset),
      tx.select({ total: sql<number>`COUNT(*)::integer` }).from(queues),
    ]);

    return {
      queues: queueRows,
      total: countRow?.total ?? 0,
    };
  });
}

/** Persist queue admission control. In-flight handlers are not interrupted. */
export async function setQueueActive(
  name: string,
  isActive: boolean,
  audit: OperationAuditContext
): Promise<Queue | undefined> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(queues)
      .where(eq(queues.name, name))
      .limit(1)
      .for('update');
    if (!existing) return undefined;

    const changed = existing.isActive !== isActive;
    let queue = existing;
    if (changed) {
      const [updated] = await tx
        .update(queues)
        .set({ isActive, updatedAt: sql`clock_timestamp()` })
        .where(eq(queues.id, existing.id))
        .returning();
      if (!updated) throw new Error(`Failed to update queue ${name}`);
      queue = updated;
    }

    await insertOperationalAudit(tx, {
      ...audit,
      action: isActive ? 'queue.resume' : 'queue.pause',
      targetType: 'queue',
      targetId: name,
      outcome: changed ? 'SUCCEEDED' : 'NOOP',
      statusCode: 200,
      metadata: { isActive },
    });
    return queue;
  });
}
