# @taskflow/events

Kafka/Redpanda event streaming for TaskFlow job lifecycle events.

## Overview

This package provides event publishing capabilities for TaskFlow using Kafka/Redpanda. Events are published when job state changes, enabling event-driven architecture, analytics, and monitoring.

**Key principle**: Redis Streams = job delivery, Kafka = event propagation.

## Features

- **Job Lifecycle Events**: Publish events for all job state transitions
- **Event Batching**: Optional batching for high-throughput scenarios
- **Idempotent Producer**: Prevents duplicate events
- **Topic Management**: Automatic topic creation and configuration
- **Connection Management**: Robust Kafka client with reconnection
- **Type-Safe**: Full TypeScript support with event schemas

## Event Types

```typescript
enum JobEventType {
  CREATED = 'job.created', // Job created
  QUEUED = 'job.queued', // Enqueued to Redis
  STARTED = 'job.started', // Worker starts processing
  COMPLETED = 'job.completed', // Job succeeded
  FAILED = 'job.failed', // Job failed
  RETRIED = 'job.retried', // Scheduled for retry
  CANCELLED = 'job.cancelled', // Job cancelled
  DEAD_LETTERED = 'job.dead_lettered', // Moved to DLQ
  TIMEOUT = 'job.timeout', // Job timed out
}
```

## Quick Start

### 1. Initialize Topics

```typescript
import { createTopicManager } from '@taskflow/events';

const topicManager = createTopicManager();

// Initialize default topics
await topicManager.initializeDefaultTopics();
```

### 2. Publish Events

```typescript
import { getEventPublisher, JobEventType } from '@taskflow/events';

const publisher = getEventPublisher();

// Publish job created event
await publisher.publish({
  eventType: JobEventType.CREATED,
  timestamp: new Date().toISOString(),
  jobId: 'job-123',
  userId: 'user-456',
  queueId: 'queue-789',
  jobType: 'send-email',
  priority: 'HIGH',
  scheduledAt: new Date().toISOString(),
  maxAttempts: 3,
  timeoutMs: 30000,
});
```

### 3. Use Convenience Functions

```typescript
import { publishJobStarted, JobEventType } from '@taskflow/events';

await publishJobStarted({
  eventType: JobEventType.STARTED,
  jobId: 'job-123',
  userId: 'user-456',
  queueId: 'queue-789',
  jobType: 'send-email',
  priority: 'HIGH',
  workerId: 'worker-1',
  attempt: 1,
  leaseId: 'lease-abc',
  leaseExpiresAt: new Date().toISOString(),
});
```

## Configuration

### Event Publisher

```typescript
import { EventPublisher } from '@taskflow/events';

const publisher = new EventPublisher({
  enabled: true, // Enable/disable publishing
  batching: false, // Batch events
  batchSize: 100, // Events per batch
  batchTimeoutMs: 1000, // Batch flush timeout
  defaultTopic: 'taskflow.job.events',
  serviceName: 'taskflow',
  environment: 'production',
});
```

### Kafka Client

```typescript
import { KafkaClient } from '@taskflow/events';

const client = new KafkaClient({
  brokers: ['localhost:19092'],
  clientId: 'taskflow',
  connectionTimeout: 10000,
  requestTimeout: 30000,
  logLevel: 'ERROR',
});
```

## Topics

### taskflow.job.events

Main topic for all job lifecycle events.

- **Partitions**: 3
- **Retention**: 7 days
- **Cleanup**: delete

### taskflow.job.lifecycle

Long-term storage for job lifecycle analytics.

- **Partitions**: 3
- **Retention**: 30 days
- **Cleanup**: delete

### taskflow.dead-letter

Events for jobs that moved to DLQ.

- **Partitions**: 1
- **Retention**: 90 days
- **Cleanup**: delete

## Event Schema

### Event Envelope

All events are wrapped in an envelope:

```typescript
{
  eventId: string; // Unique event ID
  version: string; // Schema version
  event: JobEvent; // Actual event
  metadata: {
    source: string; // Service name
    environment: string; // Environment
  }
}
```

### Job Started Event Example

```json
{
  "eventId": "evt-123",
  "version": "1.0",
  "event": {
    "eventType": "job.started",
    "timestamp": "2024-01-01T10:00:00Z",
    "jobId": "job-123",
    "userId": "user-456",
    "queueId": "queue-789",
    "jobType": "send-email",
    "priority": "HIGH",
    "workerId": "worker-1",
    "attempt": 1,
    "leaseId": "lease-abc",
    "leaseExpiresAt": "2024-01-01T10:00:30Z"
  },
  "metadata": {
    "source": "taskflow",
    "environment": "production"
  }
}
```

## Batching

Enable batching for high-throughput scenarios:

```typescript
const publisher = new EventPublisher({
  batching: true,
  batchSize: 100,
  batchTimeoutMs: 1000,
});

// Events are batched automatically
await publisher.publish(event1);
await publisher.publish(event2);
// ... batch is flushed after 100 events or 1 second
```

## Error Handling

Event publishing failures **do not** break job processing:

```typescript
try {
  await publisher.publish(event);
} catch (error) {
  // Error is logged, but not thrown
  // Job processing continues normally
}
```

This ensures that Kafka unavailability doesn't affect core job queue functionality.

## Consuming Events

### Basic Consumer

```typescript
import { getKafkaClient, KAFKA_TOPICS } from '@taskflow/events';

const client = getKafkaClient();
const consumer = await client.getConsumer('analytics-group');

await consumer.subscribe({
  topics: [KAFKA_TOPICS.JOB_EVENTS],
  fromBeginning: false,
});

await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    const envelope = JSON.parse(message.value.toString());
    console.log('Event:', envelope.event);
  },
});
```

## Integration with Worker

Events are automatically published by the worker during job processing:

```typescript
// Job started
await publishJobStarted({ ... });

// Job processing...

// Job completed
await publishJobCompleted({ ... });
```

## Production Deployment

### Environment Variables

```bash
KAFKA_BROKERS=kafka-1:9092,kafka-2:9092,kafka-3:9092
KAFKA_CLIENT_ID=taskflow
KAFKA_SSL_ENABLED=true
KAFKA_SASL_MECHANISM=scram-sha-256
KAFKA_SASL_USERNAME=taskflow
KAFKA_SASL_PASSWORD=secret
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: taskflow-api
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - name: KAFKA_BROKERS
              value: 'redpanda-0.redpanda:9092'
            - name: EVENT_PUBLISHING_ENABLED
              value: 'true'
```

## Monitoring

### Metrics

```typescript
// Producer metrics (via KafkaJS)
-connection_count -
  request_total -
  request_size -
  request_queue_size -
  response_total -
  broker_connection_errors;
```

### Logs

```typescript
// Event publishing
logger.info('Event published', {
  eventType: 'job.completed',
  jobId: 'job-123',
  topic: 'taskflow.job.events',
});
```

## Testing

### Mock Publisher

```typescript
import { EventPublisher } from '@taskflow/events';

const publisher = new EventPublisher({
  enabled: false, // Disable for tests
});
```

### Integration Tests

```typescript
describe('Event Publishing', () => {
  it('should publish job created event', async () => {
    const publisher = getEventPublisher();

    await publisher.publish({
      eventType: JobEventType.CREATED,
      // ... event data
    });

    // Verify event was published (check Kafka)
  });
});
```

## Comparison: Redis Streams vs Kafka

| Feature         | Redis Streams  | Kafka                     |
| --------------- | -------------- | ------------------------- |
| **Purpose**     | Job delivery   | Event propagation         |
| **Guarantee**   | At-least-once  | At-least-once             |
| **Retention**   | Short (hours)  | Long (days/weeks)         |
| **Consumers**   | Workers        | Analytics, monitoring     |
| **Ordering**    | Per queue      | Per partition             |
| **Performance** | Very fast (ms) | Fast (ms)                 |
| **Use Case**    | Task execution | Event-driven architecture |

**Key principle**: Redis Streams for jobs, Kafka for events.

## Best Practices

1. **Enable batching** for high-throughput scenarios (>1000 events/s)
2. **Don't throw errors** on publish failures (use fire-and-forget)
3. **Include correlation IDs** for distributed tracing
4. **Use appropriate topics** (job.events vs job.lifecycle)
5. **Monitor lag** on consumer groups
6. **Set proper retention** (balance cost vs replay capability)
7. **Test Kafka unavailability** (ensure graceful degradation)

## Troubleshooting

### Events not appearing

1. Check Kafka connection: `await topicManager.listTopics()`
2. Verify topic exists: `taskflow.job.events`
3. Check producer connection: `await client.getProducer()`
4. Enable debug logs: `logLevel: 'DEBUG'`

### High latency

1. Enable batching: `batching: true`
2. Increase batch size: `batchSize: 500`
3. Check network latency to Kafka
4. Verify Kafka broker health

### Consumer lag

1. Increase consumer concurrency
2. Optimize event processing
3. Add more consumer instances
4. Check consumer group status

## See Also

- [Architecture Documentation](/docs/architecture/system-overview.md)
- [Kafka vs Redis Streams](/docs/decisions/010-build-queue-from-scratch.md)
- [Event-Driven Architecture](https://martinfowler.com/articles/201701-event-driven.html)

## License

MIT
