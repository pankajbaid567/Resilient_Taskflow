import {
  claimPendingDeliveries,
  markDeliveryFailed,
  markDeliveryPublished,
  releaseDeliveryForRetry,
  getStaleDeliveries,
  resetDeliveryToPending,
} from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { enqueueJob } from '@taskflow/queue';

const logger = createLogger({ component: 'Dispatcher' });

/**
 * Dispatcher Configuration
 */
export interface DispatcherConfig {
  /**
   * Unique identifier for this dispatcher instance. Used as the concurrency
   * fence in job_deliveries.claimed_by. Defaults to a random UUID set at
   * construction time.
   */
  dispatcherId?: string;

  /**
   * How many delivery rows to claim per dispatch cycle.
   * Default: 50
   */
  batchSize?: number;

  /**
   * Milliseconds between dispatch cycles when there is nothing to dispatch.
   * Default: 1000 (1 second)
   */
  pollIntervalMs?: number;

  /**
   * Maximum number of Redis-level retries before a delivery row is marked
   * FAILED (leaving the job QUEUED for human inspection).
   * Default: 5
   */
  maxRedisRetries?: number;

  /**
   * Base delay for exponential backoff on transient Redis failures (ms).
   * Default: 200
   */
  retryBaseDelayMs?: number;

  /**
   * Whether to run the stale-delivery republish scan on each cycle.
   * Set to true when Redis persistence is NOT guaranteed (AOF/RDB off).
   * Default: false (assumes Redis persistence is configured)
   */
  enableStaleRepublish?: boolean;

  /**
   * Age in milliseconds after which a PUBLISHED delivery is considered
   * stale if its job is still QUEUED/RETRY_SCHEDULED. Only used when
   * enableStaleRepublish is true.
   * Default: 120_000 (2 minutes)
   */
  stalePublishedThresholdMs?: number;
}

/**
 * Dispatcher Statistics
 */
export interface DispatcherStats {
  cyclesCompleted: number;
  deliveriesPublished: number;
  deliveriesRetried: number;
  deliveriesFailed: number;
  staleRepublished: number;
  lastCycleAt?: Date;
  lastCycleDurationMs?: number;
}

type DispatcherState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED';

/**
 * Dispatcher
 *
 * Consumes rows from the job_deliveries outbox table and publishes them
 * to Redis Streams. This is the sole component that calls XADD.
 *
 * Durability properties:
 *   - Each delivery row is claimed atomically with FOR UPDATE SKIP LOCKED.
 *   - Duplicate publication is safe: the worker deduplicates via the
 *     database lease (acquireJobForDelivery returns BUSY or TERMINAL).
 *   - If the dispatcher crashes after XADD but before markDeliveryPublished,
 *     the row stays PENDING and is re-processed on the next cycle.
 *   - If the dispatcher crashes after claiming but before XADD, the stale
 *     claim is released on restart (claimed_by is process-scoped).
 *
 * Concurrent dispatchers:
 *   - Multiple instances safely coexist; FOR UPDATE SKIP LOCKED prevents
 *     double-processing of the same row.
 */
export class Dispatcher {
  private readonly dispatcherId: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxRedisRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly enableStaleRepublish: boolean;
  private readonly stalePublishedThresholdMs: number;

  private state: DispatcherState = 'IDLE';
  private pollingPromise?: Promise<void>;
  private stats: DispatcherStats = {
    cyclesCompleted: 0,
    deliveriesPublished: 0,
    deliveriesRetried: 0,
    deliveriesFailed: 0,
    staleRepublished: 0,
  };

  constructor(config: DispatcherConfig = {}) {
    this.dispatcherId =
      config.dispatcherId ?? `dispatcher-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.batchSize = config.batchSize ?? 50;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.maxRedisRetries = config.maxRedisRetries ?? 5;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 200;
    this.enableStaleRepublish = config.enableStaleRepublish ?? false;
    this.stalePublishedThresholdMs = config.stalePublishedThresholdMs ?? 120_000;

    logger.info('Dispatcher initialized', {
      dispatcherId: this.dispatcherId,
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      enableStaleRepublish: this.enableStaleRepublish,
    });
  }

  /**
   * Start the dispatcher poll loop.
   */
  start(): void {
    if (this.state !== 'IDLE') {
      throw new Error(`Cannot start dispatcher in ${this.state} state`);
    }
    this.state = 'RUNNING';
    this.pollingPromise = this.pollLoop();
    logger.info('Dispatcher started', { dispatcherId: this.dispatcherId });
  }

  /**
   * Stop the dispatcher gracefully. Waits for the current dispatch cycle
   * to finish before returning.
   */
  async stop(): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'IDLE') return;
    this.state = 'STOPPING';
    await this.pollingPromise?.catch(() => undefined);
    this.state = 'STOPPED';
    logger.info('Dispatcher stopped', { dispatcherId: this.dispatcherId });
  }

  /**
   * Run exactly one dispatch cycle — useful in tests and for manual
   * invocation without the poll loop.
   */
  async dispatchOnce(): Promise<number> {
    return this.runCycle();
  }

  getStats(): DispatcherStats {
    return { ...this.stats };
  }

  getState(): DispatcherState {
    return this.state;
  }

  // ---- Private ----

  private async pollLoop(): Promise<void> {
    while (this.state === 'RUNNING') {
      try {
        const dispatched = await this.runCycle();
        if (dispatched === 0) {
          // Nothing to do — back off before checking again
          await sleep(this.pollIntervalMs);
        }
      } catch (error) {
        logger.error('Dispatcher cycle failed', {
          dispatcherId: this.dispatcherId,
          error,
        });
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private async runCycle(): Promise<number> {
    const cycleStart = Date.now();
    let published = 0;

    // 1. Stale-delivery republish (optional, for non-persistent Redis)
    if (this.enableStaleRepublish) {
      await this.republishStaleDeliveries();
    }

    // 2. Claim PENDING delivery rows
    const claimed = await claimPendingDeliveries(this.dispatcherId, this.batchSize);

    // 3. Publish each one to Redis
    for (const delivery of claimed) {
      const success = await this.publishDelivery(delivery.id, delivery.jobId, delivery.queueName, delivery.attempt, delivery.retryCount);
      if (success) published++;
    }

    if (published > 0 || claimed.length > 0) {
      logger.debug('Dispatch cycle completed', {
        dispatcherId: this.dispatcherId,
        claimed: claimed.length,
        published,
      });
    }

    this.stats.cyclesCompleted++;
    this.stats.deliveriesPublished += published;
    this.stats.lastCycleAt = new Date();
    this.stats.lastCycleDurationMs = Date.now() - cycleStart;

    return published;
  }

  /**
   * Attempt to publish a single delivery row to Redis with bounded backoff.
   * Returns true if published (and markDeliveryPublished succeeded).
   */
  private async publishDelivery(
    deliveryId: string,
    jobId: string,
    queueName: string,
    attempt: number,
    currentRetryCount: number
  ): Promise<boolean> {
    let lastError: unknown;

    for (let retry = 0; retry <= this.maxRedisRetries; retry++) {
      if (retry > 0) {
        // Exponential backoff: 200ms, 400ms, 800ms, …
        const delayMs = Math.min(
          this.retryBaseDelayMs * 2 ** (retry - 1),
          30_000
        );
        await sleep(delayMs);
      }

      try {
        const messageId = await enqueueJob(jobId, queueName, attempt);
        // XADD succeeded — record the message ID before ACKing anything
        await markDeliveryPublished(deliveryId, messageId);
        logger.debug('Delivery published', { deliveryId, jobId, queueName, messageId, attempt });
        return true;
      } catch (error) {
        lastError = error;
        logger.warn('XADD failed, will retry', {
          deliveryId,
          jobId,
          retryAttempt: retry + 1,
          maxRetries: this.maxRedisRetries,
          error,
        });
      }
    }

    // All retries exhausted
    const newRetryCount = currentRetryCount + this.maxRedisRetries + 1;
    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);

    if (newRetryCount >= this.maxRedisRetries * 2) {
      // Permanently failed — mark for human inspection
      await markDeliveryFailed(deliveryId, errorMessage, newRetryCount);
      logger.error('Delivery permanently failed after exhausting retries', {
        deliveryId,
        jobId,
        retryCount: newRetryCount,
        error: errorMessage,
      });
      this.stats.deliveriesFailed++;
    } else {
      // Release claim so another cycle retries
      await releaseDeliveryForRetry(deliveryId, errorMessage, newRetryCount);
      this.stats.deliveriesRetried++;
    }

    return false;
  }

  /**
   * Find PUBLISHED delivery rows whose job is still QUEUED/RETRY_SCHEDULED,
   * indicating the Redis stream entry may have been lost. Reset them to
   * PENDING so the dispatcher will re-publish.
   */
  private async republishStaleDeliveries(): Promise<void> {
    try {
      const stale = await getStaleDeliveries(
        this.stalePublishedThresholdMs,
        this.batchSize
      );

      for (const { delivery } of stale) {
        await resetDeliveryToPending(delivery.id);
        this.stats.staleRepublished++;
        logger.info('Stale delivery reset to PENDING for republication', {
          deliveryId: delivery.id,
          jobId: delivery.jobId,
          publishedAt: delivery.publishedAt,
        });
      }
    } catch (error) {
      logger.error('Stale delivery scan failed', { error });
    }
  }
}

/**
 * Create a Dispatcher instance.
 */
export function createDispatcher(config?: DispatcherConfig): Dispatcher {
  return new Dispatcher(config);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
