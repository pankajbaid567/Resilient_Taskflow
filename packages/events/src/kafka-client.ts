import { createLogger } from '@taskflow/logger';
import {
  Kafka,
  KafkaConfig,
  Producer,
  Consumer,
  Admin,
  logLevel,
  SASLOptions,
} from 'kafkajs';

const logger = createLogger({ component: 'KafkaClient' });

/**
 * Kafka Client Configuration
 */
export interface TaskFlowKafkaConfig {
  /**
   * Kafka brokers
   * Default: ['localhost:19092'] (Redpanda)
   */
  brokers?: string[];

  /**
   * Client ID
   * Default: 'taskflow'
   */
  clientId?: string;

  /**
   * Connection timeout (ms)
   * Default: 10000
   */
  connectionTimeout?: number;

  /**
   * Request timeout (ms)
   * Default: 30000
   */
  requestTimeout?: number;

  /**
   * Enable SSL
   * Default: false (local development)
   */
  ssl?: boolean;

  /**
   * SASL authentication
   */
  sasl?: Extract<
    SASLOptions,
    { mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512' }
  >;

  /**
   * Log level
   * Default: ERROR
   */
  logLevel?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
}

/**
 * Kafka Client Wrapper
 *
 * Provides connection management and client lifecycle.
 */
export class KafkaClient {
  private kafka: Kafka;
  private producer?: Producer;
  private consumer?: Consumer;
  private admin?: Admin;
  private config: Required<Omit<TaskFlowKafkaConfig, 'sasl' | 'ssl'>>;

  constructor(config: TaskFlowKafkaConfig = {}) {
    this.config = {
      brokers: config.brokers || ['localhost:19092'],
      clientId: config.clientId || 'taskflow',
      connectionTimeout: config.connectionTimeout || 10000,
      requestTimeout: config.requestTimeout || 30000,
      logLevel: config.logLevel || 'ERROR',
    };

    // Map log level
    const kafkaLogLevel = this.mapLogLevel(this.config.logLevel);

    // Create Kafka instance
    const kafkaConfig: KafkaConfig = {
      clientId: this.config.clientId,
      brokers: this.config.brokers,
      connectionTimeout: this.config.connectionTimeout,
      requestTimeout: this.config.requestTimeout,
      logLevel: kafkaLogLevel,
      retry: {
        initialRetryTime: 300,
        retries: 8,
        maxRetryTime: 30000,
        multiplier: 2,
      },
    };

    // Add SSL if configured
    if (config.ssl) {
      kafkaConfig.ssl = true;
    }

    // Add SASL if configured
    if (config.sasl) {
      kafkaConfig.sasl = config.sasl;
    }

    this.kafka = new Kafka(kafkaConfig);

    logger.info('Kafka client initialized', {
      brokers: this.config.brokers,
      clientId: this.config.clientId,
    });
  }

  /**
   * Get or create producer
   */
  async getProducer(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.kafka.producer({
        allowAutoTopicCreation: true,
        transactionTimeout: 30000,
        idempotent: true, // Enable idempotent producer
        maxInFlightRequests: 5,
        retry: {
          initialRetryTime: 300,
          retries: 8,
        },
      });

      await this.producer.connect();
      logger.info('Kafka producer connected');
    }

    return this.producer;
  }

  /**
   * Get or create consumer
   */
  async getConsumer(groupId: string): Promise<Consumer> {
    if (!this.consumer) {
      this.consumer = this.kafka.consumer({
        groupId,
        sessionTimeout: 30000,
        heartbeatInterval: 3000,
        maxBytesPerPartition: 1048576, // 1MB
        retry: {
          initialRetryTime: 300,
          retries: 8,
        },
      });

      await this.consumer.connect();
      logger.info('Kafka consumer connected', { groupId });
    }

    return this.consumer;
  }

  /**
   * Get or create admin client
   */
  async getAdmin(): Promise<Admin> {
    if (!this.admin) {
      this.admin = this.kafka.admin();
      await this.admin.connect();
      logger.info('Kafka admin connected');
    }

    return this.admin;
  }

  /**
   * Disconnect all clients
   */
  async disconnect(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.producer) {
      promises.push(
        this.producer.disconnect().then(() => {
          logger.info('Kafka producer disconnected');
        })
      );
      this.producer = undefined;
    }

    if (this.consumer) {
      promises.push(
        this.consumer.disconnect().then(() => {
          logger.info('Kafka consumer disconnected');
        })
      );
      this.consumer = undefined;
    }

    if (this.admin) {
      promises.push(
        this.admin.disconnect().then(() => {
          logger.info('Kafka admin disconnected');
        })
      );
      this.admin = undefined;
    }

    await Promise.all(promises);
  }

  /**
   * Map log level to KafkaJS log level
   */
  private mapLogLevel(level: string): logLevel {
    switch (level) {
      case 'ERROR':
        return logLevel.ERROR;
      case 'WARN':
        return logLevel.WARN;
      case 'INFO':
        return logLevel.INFO;
      case 'DEBUG':
        return logLevel.DEBUG;
      default:
        return logLevel.ERROR;
    }
  }

  /**
   * Get underlying Kafka instance (for advanced usage)
   */
  getKafka(): Kafka {
    return this.kafka;
  }
}

/**
 * Global Kafka client instance
 */
let globalKafkaClient: KafkaClient | null = null;

/**
 * Get or create global Kafka client
 */
export function getKafkaClient(config?: TaskFlowKafkaConfig): KafkaClient {
  if (!globalKafkaClient) {
    globalKafkaClient = new KafkaClient(config);
  }
  return globalKafkaClient;
}

/**
 * Reset global Kafka client (for testing)
 */
export function resetKafkaClient(): void {
  if (globalKafkaClient) {
    void globalKafkaClient.disconnect().catch((error: unknown) => {
      logger.error('Error disconnecting Kafka client', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    globalKafkaClient = null;
  }
}
