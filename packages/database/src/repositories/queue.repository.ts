import { asc, eq, sql } from 'drizzle-orm';

import { db } from '../client';
import { Queue, queues } from '../schema';

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
  isActive: boolean
): Promise<Queue | undefined> {
  const [queue] = await db
    .update(queues)
    .set({ isActive, updatedAt: sql`clock_timestamp()` })
    .where(eq(queues.name, name))
    .returning();

  return queue;
}
