import { WorkerStatus } from '@taskflow/types';
import { and, eq, lt, sql } from 'drizzle-orm';


import { db } from '../client';
import { NewWorker, Worker, workers } from '../schema';

/**
 * Worker Repository
 * 
 * Handles all database operations for workers.
 */

/**
 * Register a new worker
 */
export async function registerWorker(data: NewWorker): Promise<Worker> {
  const [worker] = await db.insert(workers).values(data).returning();
  
  if (!worker) {
    throw new Error('Failed to register worker');
  }
  
  return worker;
}

/**
 * Get worker by ID
 */
export async function getWorkerById(
  workerId: string
): Promise<Worker | undefined> {
  const [worker] = await db
    .select()
    .from(workers)
    .where(eq(workers.id, workerId));
  
  return worker;
}

/**
 * Get all active workers
 */
export async function getActiveWorkers(): Promise<Worker[]> {
  return db
    .select()
    .from(workers)
    .where(eq(workers.status, 'ACTIVE'));
}

/**
 * Update worker heartbeat
 */
export async function updateWorkerHeartbeat(
  workerId: string,
  metrics: {
    currentJobCount: number;
    totalJobsProcessed: number;
    totalJobsSucceeded: number;
    totalJobsFailed: number;
  }
): Promise<Worker | null> {
  const [worker] = await db
    .update(workers)
    .set({
      lastHeartbeatAt: new Date(),
      currentJobCount: metrics.currentJobCount,
      totalJobsProcessed: metrics.totalJobsProcessed,
      totalJobsSucceeded: metrics.totalJobsSucceeded,
      totalJobsFailed: metrics.totalJobsFailed,
    })
    .where(eq(workers.id, workerId))
    .returning();
  
  return worker || null;
}

/**
 * Update worker status
 */
export async function updateWorkerStatus(
  workerId: string,
  status: WorkerStatus
): Promise<Worker | null> {
  const updates: Partial<Worker> = { status };
  
  if (status === WorkerStatus.STOPPED) {
    updates.stoppedAt = new Date();
  }
  
  const [worker] = await db
    .update(workers)
    .set(updates)
    .where(eq(workers.id, workerId))
    .returning();
  
  return worker || null;
}

/**
 * Get stale workers (heartbeat older than threshold)
 */
export async function getStaleWorkers(
  thresholdSeconds: number = 60
): Promise<Worker[]> {
  const cutoffTime = new Date(Date.now() - thresholdSeconds * 1000);
  
  return db
    .select()
    .from(workers)
    .where(
      and(
        eq(workers.status, 'ACTIVE'),
        lt(workers.lastHeartbeatAt, cutoffTime)
      )
    );
}

/**
 * Mark stale workers as failed
 */
export async function markStaleWorkersAsFailed(
  thresholdSeconds: number = 60
): Promise<number> {
  const cutoffTime = new Date(Date.now() - thresholdSeconds * 1000);
  
  const result = await db
    .update(workers)
    .set({
      status: 'FAILED',
      stoppedAt: new Date(),
    })
    .where(
      and(
        eq(workers.status, 'ACTIVE'),
        lt(workers.lastHeartbeatAt, cutoffTime)
      )
    );
  
  return result.length;
}

/**
 * Get worker statistics
 */
export async function getWorkerStats(): Promise<
  | {
      total: number;
      active: number;
      starting: number;
      stopping: number;
      stopped: number;
      failed: number;
      totalJobsProcessed: number;
      totalJobsSucceeded: number;
      totalJobsFailed: number;
    }
  | undefined
> {
  const [stats] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      active: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'ACTIVE')`,
      starting: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'STARTING')`,
      stopping: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'STOPPING')`,
      stopped: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'STOPPED')`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${workers.status} = 'FAILED')`,
      totalJobsProcessed: sql<number>`SUM(${workers.totalJobsProcessed})`,
      totalJobsSucceeded: sql<number>`SUM(${workers.totalJobsSucceeded})`,
      totalJobsFailed: sql<number>`SUM(${workers.totalJobsFailed})`,
    })
    .from(workers);
  
  return stats;
}

/**
 * Unregister worker (soft delete by marking as stopped)
 */
export async function unregisterWorker(workerId: string): Promise<Worker | null> {
  return updateWorkerStatus(workerId, WorkerStatus.STOPPED);
}

/**
 * Delete old stopped workers (cleanup)
 */
export async function deleteOldStoppedWorkers(
  olderThanDays: number = 7
): Promise<number> {
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  
  const result = await db
    .delete(workers)
    .where(
      and(
        eq(workers.status, 'STOPPED'),
        lt(workers.stoppedAt, cutoffDate)
      )
    );
  
  return result.length;
}
