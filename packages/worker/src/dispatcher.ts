import { randomUUID } from 'node:crypto';

import {
  claimPendingDeliveries,
  markDeliveryPublished,
  renewDeliveryClaim,
  releaseDeliveryForRetry,
  getStaleDeliveries,
  resetDeliveryToPending,
  type StaleDeliveryCursor,
} from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import {
  enqueueJob,
  getRedisClient,
  getStreamKey,
  WORKER_CONSUMER_GROUP,
} from '@taskflow/queue';

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
   * Maximum Redis-level retries within one dispatch cycle. Exhaustion releases
   * the durable PENDING row for a later cycle; it is not terminal failure.
   * Default: 5
   */
  maxRedisRetries?: number;

  /**
   * Base delay for exponential backoff on transient Redis failures (ms).
   * Default: 200
   */
  retryBaseDelayMs?: number;

  /**
   * How long a durable database claim may remain owned before another
   * dispatcher can recover it. Must exceed the normal Redis retry window.
   * Default: 30000 (30 seconds)
   */
  claimTimeoutMs?: number;

  /**
   * Whether to run the stale-delivery republish scan on each cycle. This is
   * enabled by default because database state, rather than Redis persistence
   * configuration, is the durable source of truth.
   * Default: true
   */
  enableStaleRepublish?: boolean;

  /**
   * Age in milliseconds after which a PUBLISHED delivery is inspected for
   * missing, acknowledged, or missing-group Redis state. Eligible database
   * states are due QUEUED/RETRY_SCHEDULED and expired
   * PROCESSING/CANCEL_REQUESTED.
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
 *   - Each delivery row is claimed atomically with FOR UPDATE SKIP LOCKED and
 *     all completion/retry mutations are fenced by the dispatcher owner ID.
 *   - Duplicate publication is safe: the worker deduplicates via the
 *     database lease (acquireJobForDelivery returns BUSY or TERMINAL).
 *   - If the dispatcher crashes after XADD but before markDeliveryPublished,
 *     the row stays PENDING and is re-processed on the next cycle.
 *   - If the dispatcher crashes after claiming but before XADD, another
 *     dispatcher reclaims it after the persisted claim timeout.
 *
 * Concurrent dispatchers:
 *   - Multiple instances safely coexist; live claims are excluded, abandoned
 *     claims are recoverable, and owner-fenced updates cannot finalize a claim
 *     that another dispatcher has recovered.
 */
export class Dispatcher {
  private readonly dispatcherId: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxRedisRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly claimTimeoutMs: number;
  private readonly enableStaleRepublish: boolean;
  private readonly stalePublishedThresholdMs: number;
  private staleDeliveryCursor?: StaleDeliveryCursor;

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
    this.dispatcherId = config.dispatcherId ?? `dispatcher-${randomUUID()}`;
    this.batchSize = config.batchSize ?? 50;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.maxRedisRetries = config.maxRedisRetries ?? 5;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 200;
    this.claimTimeoutMs = config.claimTimeoutMs ?? 30_000;
    this.enableStaleRepublish = config.enableStaleRepublish ?? true;
    this.stalePublishedThresholdMs =
      config.stalePublishedThresholdMs ?? 120_000;

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
    const claimed = await claimPendingDeliveries(
      this.dispatcherId,
      this.batchSize,
      this.claimTimeoutMs
    );

    // 3. Publish each one to Redis
    for (const delivery of claimed) {
      const success = await this.publishDelivery(
        delivery.id,
        delivery.jobId,
        delivery.queueName,
        delivery.attempt,
        delivery.retryCount
      );
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
        const stillOwned = await renewDeliveryClaim(
          deliveryId,
          this.dispatcherId
        );
        if (!stillOwned) {
          logger.warn('Delivery claim changed before Redis publication', {
            deliveryId,
            jobId,
          });
          return false;
        }

        const messageId = await enqueueJob(jobId, queueName, attempt);
        // XADD succeeded — record the message ID before ACKing anything
        const finalized = await markDeliveryPublished(
          deliveryId,
          this.dispatcherId,
          messageId
        );
        if (!finalized) {
          // XADD already happened, but a stale-claim recovery won the database
          // fence. Leave the row to its current owner. A duplicate XADD is
          // possible and is handled by the worker's database lease.
          logger.warn('Delivery claim changed after Redis publication', {
            deliveryId,
            jobId,
            messageId,
          });
          return false;
        }
        logger.debug('Delivery published', {
          deliveryId,
          jobId,
          queueName,
          messageId,
          attempt,
        });
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
    const errorMessage =
      lastError instanceof Error ? lastError.message : String(lastError);

    // Redis exhaustion is not a terminal job or delivery outcome. Persist the
    // retry count and release only our own claim. A later cycle (or replacement
    // dispatcher) will retry the still-PENDING row.
    const released = await releaseDeliveryForRetry(
      deliveryId,
      this.dispatcherId,
      errorMessage,
      newRetryCount
    );
    if (released) {
      this.stats.deliveriesRetried++;
    } else {
      logger.warn('Delivery claim changed before retry release', {
        deliveryId,
        jobId,
        retryCount: newRetryCount,
      });
    }

    return false;
  }

  /**
   * Inspect eligible PUBLISHED rows page by page. Reset entries that are
   * missing or no longer deliverable by the authoritative consumer group so
   * the dispatcher republishes them from PostgreSQL.
   */
  private async republishStaleDeliveries(): Promise<void> {
    try {
      const stale = await getStaleDeliveries(
        this.stalePublishedThresholdMs,
        this.batchSize,
        this.staleDeliveryCursor
      );

      if (stale.length === 0) {
        this.staleDeliveryCursor = undefined;
        return;
      }

      for (const { delivery } of stale) {
        if (delivery.redisMessageId) {
          const stream = getStreamKey(delivery.queueName);
          const deliveryState = await inspectRedisDelivery(
            stream,
            delivery.redisMessageId
          );
          if (deliveryState === 'PENDING' || deliveryState === 'UNDELIVERED') {
            continue;
          }
        }

        const reset = await resetDeliveryToPending(delivery.id);
        if (reset) {
          this.stats.staleRepublished++;
          logger.info('Stale delivery reset to PENDING for republication', {
            deliveryId: delivery.id,
            jobId: delivery.jobId,
            publishedAt: delivery.publishedAt,
          });
        }
      }

      const lastDelivery = stale[stale.length - 1]!.delivery;
      if (stale.length < this.batchSize) {
        this.staleDeliveryCursor = undefined;
      } else {
        this.staleDeliveryCursor = {
          deliveryId: lastDelivery.id,
        };
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

type RedisDeliveryState =
  'MISSING' | 'GROUP_MISSING' | 'PENDING' | 'UNDELIVERED' | 'ACKNOWLEDGED';

/**
 * Determine whether the authoritative consumer group can still deliver a
 * recorded stream entry. Physical presence alone is insufficient because an
 * acknowledged entry remains visible to XRANGE but cannot be read again with
 * XREADGROUP `>`.
 */
async function inspectRedisDelivery(
  stream: string,
  messageId: string
): Promise<RedisDeliveryState> {
  const redis = getRedisClient();
  const existing = await redis.xrange(stream, messageId, messageId, 'COUNT', 1);
  if (existing.length === 0) return 'MISSING';

  const rawGroups = (await redis.xinfo('GROUPS', stream)) as unknown;
  const groups = Array.isArray(rawGroups) ? rawGroups : [];
  const group = groups.find(
    (candidate): candidate is unknown[] =>
      Array.isArray(candidate) &&
      readRedisInfoField(candidate, 'name') === WORKER_CONSUMER_GROUP
  );
  if (!group) return 'GROUP_MISSING';

  const pending = (await redis.xpending(
    stream,
    WORKER_CONSUMER_GROUP,
    messageId,
    messageId,
    1
  )) as unknown;
  if (Array.isArray(pending) && pending.length > 0) return 'PENDING';

  const lastDeliveredId = readRedisInfoField(group, 'last-delivered-id');
  if (typeof lastDeliveredId !== 'string') {
    throw new Error(
      `Redis group ${WORKER_CONSUMER_GROUP} omitted last-delivered-id`
    );
  }

  return compareRedisStreamIds(messageId, lastDeliveredId) > 0
    ? 'UNDELIVERED'
    : 'ACKNOWLEDGED';
}

function readRedisInfoField(fields: unknown[], name: string): unknown {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === name) return fields[index + 1];
  }
  return undefined;
}

function compareRedisStreamIds(left: string, right: string): number {
  const leftParts = parseRedisStreamId(left);
  const rightParts = parseRedisStreamId(right);
  if (leftParts[0] !== rightParts[0]) {
    return leftParts[0] < rightParts[0] ? -1 : 1;
  }
  if (leftParts[1] === rightParts[1]) return 0;
  return leftParts[1] < rightParts[1] ? -1 : 1;
}

function parseRedisStreamId(value: string): [bigint, bigint] {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid Redis stream ID: ${value}`);
  }
  return [BigInt(match[1]), BigInt(match[2])];
}
