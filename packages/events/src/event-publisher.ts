import { randomUUID } from 'crypto';

import { createLogger } from '@taskflow/logger';
import { Producer } from 'kafkajs';

import {
  JobEvent,
  EventEnvelope,
  KAFKA_TOPICS,
  JobEventType,
} from './event-schema';
import { getKafkaClient } from './kafka-client';

const logger = createLogger({ component: 'EventPublisher' });

/**
 * Event Publisher Configuration
 */
export interface EventPublisherConfig {
  /**
   * Enable event publishing
   * Default: true
   */
  enabled?: boolean;

  /**
   * Batch events before sending
   * Default: false
   */
  batching?: boolean;

  /**
   * Batch size (if batching enabled)
   * Default: 100
   */
  batchSize?: number;

  /**
   * Batch timeout (milliseconds)
   * Default: 1000
   */
  batchTimeoutMs?: number;

  /**
   * Default topic
   * Default: KAFKA_TOPICS.JOB_EVENTS
   */
  defaultTopic?: string;

  /**
   * Service name (for metadata)
   * Default: 'taskflow'
   */
  serviceName?: string;

  /**
   * Environment (for metadata)
   * Default: process.env.NODE_ENV
   */
  environment?: string;
}

/**
 * Event Publisher
 *
 * Publishes job lifecycle events to Kafka/Redpanda.
 */
export class EventPublisher {
  private producer: Producer | null = null;
  private config: Required<EventPublisherConfig>;
  private batch: Array<{ topic: string; envelope: EventEnvelope }> = [];
  private batchTimer?: NodeJS.Timeout;

  constructor(config: EventPublisherConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      batching: config.batching ?? false,
      batchSize: config.batchSize ?? 100,
      batchTimeoutMs: config.batchTimeoutMs ?? 1000,
      defaultTopic: config.defaultTopic ?? KAFKA_TOPICS.JOB_EVENTS,
      serviceName: config.serviceName ?? 'taskflow',
      environment: config.environment ?? process.env.NODE_ENV ?? 'development',
    };

    logger.info('Event publisher initialized', {
      enabled: this.config.enabled,
      batching: this.config.batching,
      defaultTopic: this.config.defaultTopic,
    });
  }

  /**
   * Initialize producer
   */
  private async getProducer(): Promise<Producer> {
    if (!this.producer) {
      const client = getKafkaClient();
      this.producer = await client.getProducer();
    }
    return this.producer;
  }

  /**
   * Publish a job event
   */
  async publish(
    event: JobEvent,
    options: {
      topic?: string;
      correlationId?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    if (!this.config.enabled) {
      logger.debug('Event publishing disabled, skipping', {
        eventType: event.eventType,
        jobId: event.jobId,
      });
      return;
    }

    try {
      // Create event envelope
      const envelope: EventEnvelope = {
        eventId: randomUUID(),
        version: '1.0',
        event,
        metadata: {
          source: this.config.serviceName,
          environment: this.config.environment,
          ...options.metadata,
        },
      };

      const topic = options.topic || this.config.defaultTopic;

      // Batching or immediate send
      if (this.config.batching) {
        await this.addToBatch(topic, envelope);
      } else {
        await this.sendEvent(topic, envelope, options.correlationId);
      }
    } catch (error) {
      logger.error('Failed to publish event', {
        eventType: event.eventType,
        jobId: event.jobId,
        error: error instanceof Error ? error.message : error,
      });

      // Don't throw - event publishing failures should not break job processing
    }
  }

  /**
   * Add event to batch
   */
  private async addToBatch(
    topic: string,
    envelope: EventEnvelope
  ): Promise<void> {
    this.batch.push({ topic, envelope });

    // Flush if batch is full
    if (this.batch.length >= this.config.batchSize) {
      await this.flushBatch();
    } else if (!this.batchTimer) {
      // Start batch timer
      this.batchTimer = setTimeout(() => {
        void this.flushBatch().catch((error: unknown) => {
          logger.error('Failed to flush batch', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.config.batchTimeoutMs);
    }
  }

  /**
   * Flush batch
   */
  private async flushBatch(): Promise<void> {
    if (this.batch.length === 0) {
      return;
    }

    // Clear timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    // Get batch and clear
    const batch = [...this.batch];
    this.batch = [];

    // Group by topic
    const grouped = new Map<string, EventEnvelope[]>();
    for (const { topic, envelope } of batch) {
      if (!grouped.has(topic)) {
        grouped.set(topic, []);
      }
      grouped.get(topic)!.push(envelope);
    }

    // Send to Kafka
    const producer = await this.getProducer();

    const messages = Array.from(grouped.entries()).flatMap(
      ([topic, envelopes]) =>
        envelopes.map((envelope) => ({
          topic,
          messages: [
            {
              key: envelope.event.jobId,
              value: JSON.stringify(envelope),
              headers: this.buildHeaders(envelope),
            },
          ],
        }))
    );

    await producer.sendBatch({
      topicMessages: messages,
      acks: 1, // Wait for leader acknowledgment
    });

    logger.debug('Batch flushed', {
      count: batch.length,
      topics: Array.from(grouped.keys()),
    });
  }

  /**
   * Send single event
   */
  private async sendEvent(
    topic: string,
    envelope: EventEnvelope,
    correlationId?: string
  ): Promise<void> {
    const producer = await this.getProducer();

    await producer.send({
      topic,
      messages: [
        {
          key: envelope.event.jobId,
          value: JSON.stringify(envelope),
          headers: this.buildHeaders(envelope, correlationId),
        },
      ],
      acks: 1, // Wait for leader acknowledgment
    });

    logger.debug('Event published', {
      eventType: envelope.event.eventType,
      jobId: envelope.event.jobId,
      topic,
    });
  }

  /**
   * Build Kafka message headers
   */
  private buildHeaders(
    envelope: EventEnvelope,
    correlationId?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      eventType: envelope.event.eventType,
      eventId: envelope.eventId,
      jobId: envelope.event.jobId,
      userId: envelope.event.userId,
      timestamp: envelope.event.timestamp,
    };

    if (correlationId || envelope.event.correlationId) {
      headers.correlationId = correlationId || envelope.event.correlationId!;
    }

    return headers;
  }

  /**
   * Gracefully shutdown
   */
  async shutdown(): Promise<void> {
    // Flush any pending batch
    if (this.config.batching && this.batch.length > 0) {
      await this.flushBatch();
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    logger.info('Event publisher shutdown');
  }
}

/**
 * Global event publisher instance
 */
let globalPublisher: EventPublisher | null = null;

/**
 * Get or create global event publisher
 */
export function getEventPublisher(
  config?: EventPublisherConfig
): EventPublisher {
  if (!globalPublisher) {
    globalPublisher = new EventPublisher(config);
  }
  return globalPublisher;
}

/**
 * Reset global event publisher (for testing)
 */
export function resetEventPublisher(): void {
  if (globalPublisher) {
    void globalPublisher.shutdown().catch((error: unknown) => {
      logger.error('Error shutting down event publisher', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    globalPublisher = null;
  }
}

/**
 * Convenience functions for publishing specific events
 */

export async function publishJobCreated(
  event: Omit<JobEvent, 'eventType' | 'timestamp'> & {
    eventType: JobEventType.CREATED;
  }
): Promise<void> {
  const publisher = getEventPublisher();
  await publisher.publish({
    ...event,
    timestamp: new Date().toISOString(),
  } as JobEvent);
}

export async function publishJobStarted(
  event: Omit<JobEvent, 'eventType' | 'timestamp'> & {
    eventType: JobEventType.STARTED;
  }
): Promise<void> {
  const publisher = getEventPublisher();
  await publisher.publish({
    ...event,
    timestamp: new Date().toISOString(),
  } as JobEvent);
}

export async function publishJobCompleted(
  event: Omit<JobEvent, 'eventType' | 'timestamp'> & {
    eventType: JobEventType.COMPLETED;
  }
): Promise<void> {
  const publisher = getEventPublisher();
  await publisher.publish({
    ...event,
    timestamp: new Date().toISOString(),
  } as JobEvent);
}

export async function publishJobFailed(
  event: Omit<JobEvent, 'eventType' | 'timestamp'> & {
    eventType: JobEventType.FAILED;
  }
): Promise<void> {
  const publisher = getEventPublisher();
  await publisher.publish({
    ...event,
    timestamp: new Date().toISOString(),
  } as JobEvent);
}

export async function publishJobCancelled(
  event: Omit<JobEvent, 'eventType' | 'timestamp'> & {
    eventType: JobEventType.CANCELLED;
  }
): Promise<void> {
  const publisher = getEventPublisher();
  await publisher.publish({
    ...event,
    timestamp: new Date().toISOString(),
  } as JobEvent);
}
