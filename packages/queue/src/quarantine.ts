import { createLogger } from '@taskflow/logger';

import { getRedisClient } from './redis-client';
import { WORKER_CONSUMER_GROUP } from './stream-names';

const logger = createLogger({ component: 'QueueQuarantine' });

/**
 * Quarantine an unprocessable or poison stream entry.
 *
 * Acknowledges (XACK) the entry so it leaves the consumer group's PEL,
 * preventing it from permanently stalling recovery of valid messages,
 * and records it to a quarantine Redis stream for auditing and inspection.
 *
 * @param streamKey - The Redis stream key the message originated from
 * @param messageId - The Redis stream entry ID
 * @param reason    - Explanation for quarantining (e.g. malformed envelope, persistent not-found)
 * @param metadata  - Optional contextual details (e.g. error, payload)
 * @param rawEntry  - Exact Redis entry returned by the consumer, when available
 */
export async function quarantineEntry(
  streamKey: string,
  messageId: string,
  reason: string,
  metadata?: Record<string, unknown>,
  rawEntry?: unknown
): Promise<void> {
  const redis = getRedisClient();
  const groupName = WORKER_CONSUMER_GROUP;
  const quarantineStreamKey = `${streamKey}:quarantine`;

  logger.warn('Quarantining stream entry', {
    stream: streamKey,
    messageId,
    reason,
    metadata,
  });

  try {
    const quarantineMessageId = await redis.xadd(
      quarantineStreamKey,
      '*',
      'messageId',
      messageId,
      'originalStream',
      streamKey,
      'reason',
      reason,
      'quarantinedAt',
      new Date().toISOString(),
      'metadata',
      JSON.stringify(metadata ?? {}),
      'rawEntry',
      JSON.stringify(rawEntry ?? null)
    );

    if (quarantineMessageId === null) {
      throw new Error('Redis quarantine XADD did not return a message ID');
    }
  } catch (error) {
    logger.error('Failed to log quarantined entry to quarantine stream', {
      stream: streamKey,
      messageId,
      error,
    });
    // The source entry must remain pending when its audit copy is not durable.
    // Re-throw before XACK so a later reclaim can retry quarantine persistence.
    throw error;
  }

  if (messageId !== '<unknown>') {
    try {
      await redis.xack(streamKey, groupName, messageId);
    } catch (ackError) {
      logger.error('Failed to XACK quarantined entry', {
        stream: streamKey,
        messageId,
        error: ackError,
      });
      throw ackError;
    }
  }
}
