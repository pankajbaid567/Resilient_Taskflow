import { Admin, ITopicConfig } from 'kafkajs';

import { createLogger } from '@taskflow/logger';

import { getKafkaClient } from './kafka-client';
import { KAFKA_TOPICS } from './event-schema';

const logger = createLogger({ component: 'TopicManager' });

/**
 * Topic Configuration
 */
export interface TopicConfig {
  /**
   * Topic name
   */
  topic: string;

  /**
   * Number of partitions
   * Default: 3
   */
  numPartitions?: number;

  /**
   * Replication factor
   * Default: 1 (local dev)
   */
  replicationFactor?: number;

  /**
   * Retention time (milliseconds)
   * Default: 7 days
   */
  retentionMs?: number;

  /**
   * Cleanup policy
   * Default: 'delete'
   */
  cleanupPolicy?: 'delete' | 'compact';
}

/**
 * Topic Manager
 * 
 * Manages Kafka topic lifecycle (create, delete, list).
 */
export class TopicManager {
  private admin: Admin | null = null;

  /**
   * Get admin client
   */
  private async getAdmin(): Promise<Admin> {
    if (!this.admin) {
      const client = getKafkaClient();
      this.admin = await client.getAdmin();
    }
    return this.admin;
  }

  /**
   * Create topics if they don't exist
   */
  async createTopics(configs: TopicConfig[]): Promise<void> {
    const admin = await this.getAdmin();

    // Get existing topics
    const existingTopics = await admin.listTopics();

    // Filter topics that need to be created
    const topicsToCreate = configs.filter(
      (config) => !existingTopics.includes(config.topic)
    );

    if (topicsToCreate.length === 0) {
      logger.info('All topics already exist');
      return;
    }

    // Create topics
    const topicConfigs: ITopicConfig[] = topicsToCreate.map((config) => ({
      topic: config.topic,
      numPartitions: config.numPartitions ?? 3,
      replicationFactor: config.replicationFactor ?? 1,
      configEntries: [
        {
          name: 'retention.ms',
          value: String(config.retentionMs ?? 7 * 24 * 60 * 60 * 1000), // 7 days
        },
        {
          name: 'cleanup.policy',
          value: config.cleanupPolicy ?? 'delete',
        },
      ],
    }));

    await admin.createTopics({
      topics: topicConfigs,
      waitForLeaders: true,
    });

    logger.info('Topics created', {
      topics: topicsToCreate.map((c) => c.topic),
    });
  }

  /**
   * Initialize default TaskFlow topics
   */
  async initializeDefaultTopics(): Promise<void> {
    logger.info('Initializing default Kafka topics');

    const defaultTopics: TopicConfig[] = [
      {
        topic: KAFKA_TOPICS.JOB_EVENTS,
        numPartitions: 3,
        replicationFactor: 1,
        retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        cleanupPolicy: 'delete',
      },
      {
        topic: KAFKA_TOPICS.JOB_LIFECYCLE,
        numPartitions: 3,
        replicationFactor: 1,
        retentionMs: 30 * 24 * 60 * 60 * 1000, // 30 days
        cleanupPolicy: 'delete',
      },
      {
        topic: KAFKA_TOPICS.DEAD_LETTER,
        numPartitions: 1,
        replicationFactor: 1,
        retentionMs: 90 * 24 * 60 * 60 * 1000, // 90 days
        cleanupPolicy: 'delete',
      },
    ];

    await this.createTopics(defaultTopics);

    logger.info('Default topics initialized');
  }

  /**
   * List all topics
   */
  async listTopics(): Promise<string[]> {
    const admin = await this.getAdmin();
    return admin.listTopics();
  }

  /**
   * Delete topics (use with caution!)
   */
  async deleteTopics(topics: string[]): Promise<void> {
    const admin = await this.getAdmin();

    await admin.deleteTopics({
      topics,
    });

    logger.warn('Topics deleted', { topics });
  }

  /**
   * Get topic metadata
   */
  async getTopicMetadata(topics: string[]): Promise<any> {
    const admin = await this.getAdmin();

    return admin.fetchTopicMetadata({
      topics,
    });
  }
}

/**
 * Create topic manager instance
 */
export function createTopicManager(): TopicManager {
  return new TopicManager();
}
