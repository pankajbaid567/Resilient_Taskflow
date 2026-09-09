/**
 * @taskflow/events
 * 
 * Kafka/Redpanda event streaming for TaskFlow.
 * 
 * Features:
 * - Job lifecycle events (created, started, completed, etc.)
 * - Event publishing with batching support
 * - Topic management and initialization
 * - Kafka client wrapper with connection management
 */

// Kafka Client
export {
  KafkaClient,
  TaskFlowKafkaConfig,
  getKafkaClient,
  resetKafkaClient,
} from './kafka-client';

// Event Schema
export {
  JobEventType,
  BaseJobEvent,
  JobCreatedEvent,
  JobQueuedEvent,
  JobStartedEvent,
  JobCompletedEvent,
  JobFailedEvent,
  JobRetriedEvent,
  JobCancelledEvent,
  JobDeadLetteredEvent,
  JobTimeoutEvent,
  JobEvent,
  EventEnvelope,
  KAFKA_TOPICS,
  KafkaMessageHeaders,
} from './event-schema';

// Event Publisher
export {
  EventPublisher,
  EventPublisherConfig,
  getEventPublisher,
  resetEventPublisher,
  publishJobCreated,
  publishJobStarted,
  publishJobCompleted,
  publishJobFailed,
  publishJobCancelled,
} from './event-publisher';

// Topic Manager
export {
  TopicManager,
  TopicConfig,
  createTopicManager,
} from './topic-manager';
