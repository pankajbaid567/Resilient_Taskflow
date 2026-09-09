/**
 * Kafka testing utilities
 * Provides helpers for managing test Kafka state
 */

import { Kafka, Producer, Consumer, Admin } from 'kafkajs';

export class TestKafka {
  private kafka?: Kafka;
  private admin?: Admin;
  private producer?: Producer;
  private consumers: Consumer[] = [];

  async connect(brokers: string[]): Promise<void> {
    this.kafka = new Kafka({
      clientId: 'test-client',
      brokers,
      retry: {
        retries: 5,
        initialRetryTime: 300,
      },
    });

    this.admin = this.kafka.admin();
    await this.admin.connect();

    this.producer = this.kafka.producer();
    await this.producer.connect();
  }

  async createTopic(topic: string, numPartitions: number = 1): Promise<void> {
    if (!this.admin) {
      throw new Error('Kafka not connected');
    }

    try {
      await this.admin.createTopics({
        topics: [{ topic, numPartitions }],
        waitForLeaders: true,
      });
    } catch (error: any) {
      if (!error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  async deleteTopic(topic: string): Promise<void> {
    if (!this.admin) {
      throw new Error('Kafka not connected');
    }

    try {
      await this.admin.deleteTopics({ topics: [topic] });
    } catch (error) {
      // Topic might not exist
    }
  }

  async deleteAllTopics(): Promise<void> {
    if (!this.admin) {
      throw new Error('Kafka not connected');
    }

    const topics = await this.admin.listTopics();
    const userTopics = topics.filter((t) => !t.startsWith('__'));

    if (userTopics.length > 0) {
      await this.admin.deleteTopics({ topics: userTopics });
    }
  }

  async produceMessage(
    topic: string,
    message: { key?: string; value: string }
  ): Promise<void> {
    if (!this.producer) {
      throw new Error('Kafka not connected');
    }

    await this.producer.send({
      topic,
      messages: [message],
    });
  }

  async createConsumer(groupId: string): Promise<Consumer> {
    if (!this.kafka) {
      throw new Error('Kafka not connected');
    }

    const consumer = this.kafka.consumer({ groupId });
    await consumer.connect();
    this.consumers.push(consumer);

    return consumer;
  }

  async consumeMessages(
    topic: string,
    groupId: string,
    onMessage: (message: any) => Promise<void>,
    timeout: number = 5000
  ): Promise<void> {
    const consumer = await this.createConsumer(groupId);

    await consumer.subscribe({ topic, fromBeginning: true });

    await consumer.run({
      eachMessage: async ({ message }) => {
        await onMessage(message);
      },
    });

    // Wait for messages
    await new Promise((resolve) => setTimeout(resolve, timeout));
  }

  async disconnect(): Promise<void> {
    // Disconnect all consumers
    await Promise.all(this.consumers.map((c) => c.disconnect()));
    this.consumers = [];

    if (this.producer) {
      await this.producer.disconnect();
      this.producer = undefined;
    }

    if (this.admin) {
      await this.admin.disconnect();
      this.admin = undefined;
    }

    this.kafka = undefined;
  }

  getProducer(): Producer {
    if (!this.producer) {
      throw new Error('Kafka not connected');
    }
    return this.producer;
  }

  getAdmin(): Admin {
    if (!this.admin) {
      throw new Error('Kafka not connected');
    }
    return this.admin;
  }
}

/**
 * Create a test Kafka instance
 */
export function createTestKafka(): TestKafka {
  return new TestKafka();
}

/**
 * Kafka fixture for tests
 */
export async function withTestKafka<T>(
  fn: (kafka: TestKafka) => Promise<T>
): Promise<T> {
  const testKafka = createTestKafka();

  try {
    const brokers =
      process.env.TEST_KAFKA_BROKERS?.split(',') || ['localhost:9093'];

    await testKafka.connect(brokers);
    await testKafka.deleteAllTopics();

    return await fn(testKafka);
  } finally {
    await testKafka.disconnect();
  }
}
