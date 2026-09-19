# @taskflow/observability

Comprehensive observability package for Resilient TaskFlow distributed task queue.

## Features

### Prometheus Metrics

- **70+ metrics** covering jobs, queues, workers, API, database, Redis, Kafka
- Counters, gauges, histograms, and summaries
- Industry-standard naming (`taskflow_*`)
- Cardinality-optimized labels
- Production-ready buckets and percentiles

### OpenTelemetry Distributed Tracing

- Automatic instrumentation for Fastify, PostgreSQL, Redis, HTTP
- Custom span creation and attributes
- Job lifecycle tracing
- Worker lifecycle tracing
- Queue operation tracing
- Context propagation across services
- OTLP export to Jaeger, Tempo, or any OTLP collector

## Installation

```bash
pnpm add @taskflow/observability
```

## Usage

### 1. Initialize Tracing (Application Startup)

```typescript
import { initializeTracing, shutdownTracing } from '@taskflow/observability';

// Initialize before any other imports
initializeTracing('taskflow-api'); // or 'taskflow-worker'

// The application owns SIGTERM/SIGINT and calls this from its shutdown path.
await shutdownTracing();
```

`initializeTracing` never installs process signal handlers. Repeated initialization
returns the active SDK, and concurrent shutdown calls share one shutdown operation.

### 2. Prometheus Metrics

#### Increment Counters

```typescript
import {
  jobsSubmittedTotal,
  jobsCompletedTotal,
} from '@taskflow/observability';

// Job submitted
jobsSubmittedTotal
  .labels({
    queue: 'default',
    type: 'send_email',
    priority: 'NORMAL',
  })
  .inc();

// Job completed
jobsCompletedTotal
  .labels({
    queue: 'default',
    type: 'send_email',
  })
  .inc();
```

#### Update Gauges

```typescript
import { queueDepth, workersActive } from '@taskflow/observability';

// Update queue depth
queueDepth.labels({ queue: 'default', priority: 'HIGH' }).set(150);

// Update active workers
workersActive.labels({ queue: 'default' }).set(5);
```

#### Record Histograms

```typescript
import { jobDurationSeconds } from '@taskflow/observability';

const startTime = Date.now();
// ... process job
const durationSeconds = (Date.now() - startTime) / 1000;

jobDurationSeconds
  .labels({
    queue: 'default',
    type: 'send_email',
    status: 'completed',
  })
  .observe(durationSeconds);
```

#### Export Metrics Endpoint

```typescript
import { getMetrics } from '@taskflow/observability';
import { FastifyInstance } from 'fastify';

app.get('/metrics', async (request, reply) => {
  const metrics = await getMetrics();
  return reply
    .header('Content-Type', 'text/plain; version=0.0.4')
    .send(metrics);
});
```

### 3. OpenTelemetry Tracing

#### Automatic Instrumentation

Once initialized, HTTP, Fastify, PostgreSQL, and Redis are automatically instrumented.

#### Custom Spans

```typescript
import { withSpan, addSpanAttributes } from '@taskflow/observability';

async function processJob(jobId: string) {
  return withSpan('processJob', { jobId }, async (span) => {
    // ... do work
    span.setAttribute('result', 'success');
    span.setAttribute('recordsProcessed', 100);
    return result;
  });
}
```

#### Job Lifecycle Tracing

```typescript
import { JobTracing } from '@taskflow/observability';

// Start job processing
const span = JobTracing.startJobProcessing(jobId, jobType, queue);

try {
  // Record events
  JobTracing.recordJobStarted(jobId, workerId);

  // ... process job

  JobTracing.recordJobCompleted(jobId, durationMs);
  span.setStatus({ code: SpanStatusCode.OK });
} catch (error) {
  JobTracing.recordJobFailed(jobId, error, attempt);
  recordError(span, error);
} finally {
  endSpan(span);
}
```

#### Worker Lifecycle Tracing

```typescript
import { WorkerTracing } from '@taskflow/observability';

// Worker lifecycle
const span = WorkerTracing.startWorkerLifecycle(workerId);

// Heartbeat
WorkerTracing.recordWorkerHeartbeat(workerId, jobCount);

// Lease operations
WorkerTracing.recordLeaseAcquisition(jobId, workerId, leaseMs);
WorkerTracing.recordLeaseRenewal(jobId, workerId);
```

#### Queue Operation Tracing

```typescript
import { QueueTracing } from '@taskflow/observability';

QueueTracing.recordMessageEnqueued(queue, messageId);
QueueTracing.recordMessageConsumed(queue, messageId);
QueueTracing.recordMessageAcknowledged(queue, messageId);
```

## Metrics Catalog

### Job Metrics

| Metric                               | Type      | Description                       |
| ------------------------------------ | --------- | --------------------------------- |
| `taskflow_jobs_submitted_total`      | Counter   | Total jobs submitted              |
| `taskflow_jobs_started_total`        | Counter   | Total jobs started by workers     |
| `taskflow_jobs_completed_total`      | Counter   | Total jobs completed successfully |
| `taskflow_jobs_failed_total`         | Counter   | Total jobs failed                 |
| `taskflow_jobs_retried_total`        | Counter   | Total job retries                 |
| `taskflow_jobs_dead_lettered_total`  | Counter   | Total jobs moved to DLQ           |
| `taskflow_jobs_cancelled_total`      | Counter   | Total jobs cancelled              |
| `taskflow_jobs_timed_out_total`      | Counter   | Total jobs timed out              |
| `taskflow_jobs_current`              | Gauge     | Current jobs by status            |
| `taskflow_job_duration_seconds`      | Histogram | Job execution duration            |
| `taskflow_job_wait_duration_seconds` | Histogram | Time from submission to start     |
| `taskflow_job_retry_attempts`        | Histogram | Number of retry attempts          |

### Queue Metrics

| Metric                        | Type  | Description                        |
| ----------------------------- | ----- | ---------------------------------- |
| `taskflow_queue_depth`        | Gauge | Current jobs waiting in queue      |
| `taskflow_queue_lag_seconds`  | Gauge | Age of oldest job in queue         |
| `taskflow_redis_consumer_lag` | Gauge | Pending messages in consumer group |
| `taskflow_dlq_depth`          | Gauge | Current jobs in DLQ                |

### Worker Metrics

| Metric                                             | Type    | Description                  |
| -------------------------------------------------- | ------- | ---------------------------- |
| `taskflow_workers_active`                          | Gauge   | Number of active workers     |
| `taskflow_worker_failures_total`                   | Counter | Total worker failures        |
| `taskflow_worker_heartbeats_total`                 | Counter | Total worker heartbeats      |
| `taskflow_worker_jobs_concurrent`                  | Gauge   | Current jobs being processed |
| `taskflow_worker_lease_renewals_total`             | Counter | Total lease renewals         |
| `taskflow_worker_lease_acquisition_failures_total` | Counter | Lease acquisition failures   |

### Scheduler Metrics

| Metric                                    | Type      | Description                       |
| ----------------------------------------- | --------- | --------------------------------- |
| `taskflow_scheduler_runs_total`           | Counter   | Total scheduler cycles            |
| `taskflow_scheduler_jobs_scheduled_total` | Counter   | Total jobs scheduled              |
| `taskflow_scheduler_errors_total`         | Counter   | Total scheduler errors            |
| `taskflow_scheduler_run_duration_seconds` | Histogram | Scheduler cycle duration          |
| `taskflow_scheduler_lag_seconds`          | Gauge     | How late jobs are being scheduled |

### API Metrics

| Metric                                   | Type      | Description                  |
| ---------------------------------------- | --------- | ---------------------------- |
| `taskflow_http_requests_total`           | Counter   | Total HTTP requests          |
| `taskflow_http_request_duration_seconds` | Histogram | HTTP request duration        |
| `taskflow_rate_limit_hits_total`         | Counter   | Total rate limit checks      |
| `taskflow_rate_limit_duration_seconds`   | Histogram | Rate limit check duration    |
| `taskflow_idempotency_key_hits_total`    | Counter   | Total idempotency key checks |

### Kafka/Event Metrics

| Metric                                    | Type      | Description            |
| ----------------------------------------- | --------- | ---------------------- |
| `taskflow_events_published_total`         | Counter   | Total events published |
| `taskflow_event_publish_failures_total`   | Counter   | Event publish failures |
| `taskflow_event_publish_duration_seconds` | Histogram | Event publish duration |
| `taskflow_event_batch_size`               | Summary   | Events in batch        |

### Database Metrics

| Metric                                     | Type      | Description             |
| ------------------------------------------ | --------- | ----------------------- |
| `taskflow_db_queries_total`                | Counter   | Total database queries  |
| `taskflow_db_query_duration_seconds`       | Histogram | Database query duration |
| `taskflow_db_connection_pool_size`         | Gauge     | Connection pool size    |
| `taskflow_db_transaction_duration_seconds` | Histogram | Transaction duration    |

### Redis Metrics

| Metric                                    | Type      | Description                |
| ----------------------------------------- | --------- | -------------------------- |
| `taskflow_redis_commands_total`           | Counter   | Total Redis commands       |
| `taskflow_redis_command_duration_seconds` | Histogram | Redis command duration     |
| `taskflow_redis_connection_pool_size`     | Gauge     | Redis connection pool size |

## Prometheus Configuration

### Scrape Config

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'taskflow-api'
    static_configs:
      - targets: ['api:3000']
    metrics_path: '/metrics'
    scrape_interval: 15s

  - job_name: 'taskflow-worker'
    static_configs:
      - targets: ['worker-1:3001', 'worker-2:3001', 'worker-3:3001']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

### Useful Queries (PromQL)

#### Job Throughput

```promql
rate(taskflow_jobs_completed_total[5m])
```

#### Job Success Rate

```promql
rate(taskflow_jobs_completed_total[5m])
/
(rate(taskflow_jobs_completed_total[5m]) + rate(taskflow_jobs_failed_total[5m]))
```

#### P95 Job Duration

```promql
histogram_quantile(0.95,
  rate(taskflow_job_duration_seconds_bucket[5m])
)
```

#### Queue Backlog Growth Rate

```promql
deriv(taskflow_queue_depth[5m])
```

#### Worker Utilization

```promql
taskflow_worker_jobs_concurrent
/
10  # max concurrency
```

## OpenTelemetry Configuration

### Environment Variables

```bash
# OTLP Exporter endpoint
export OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318

# Service name (set in code)
# export OTEL_SERVICE_NAME=taskflow-api

# Sampling (1.0 = 100%, 0.1 = 10%)
export OTEL_TRACES_SAMPLER=parentbased_traceidratio
export OTEL_TRACES_SAMPLER_ARG=1.0
```

### Jaeger All-in-One

```yaml
# docker-compose.yml
services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - '16686:16686' # Jaeger UI
      - '4318:4318' # OTLP HTTP
    environment:
      - COLLECTOR_OTLP_ENABLED=true
```

### Grafana Tempo

```yaml
# docker-compose.yml
services:
  tempo:
    image: grafana/tempo:latest
    command: ['-config.file=/etc/tempo.yaml']
    volumes:
      - ./tempo.yaml:/etc/tempo.yaml
    ports:
      - '4318:4318' # OTLP HTTP
      - '3200:3200' # Tempo HTTP
```

## Best Practices

### 1. Metric Cardinality

**❌ Bad** (unbounded cardinality):

```typescript
jobsSubmittedTotal
  .labels({
    userId: userId, // Millions of users!
    jobId: jobId, // Unbounded!
  })
  .inc();
```

**✅ Good** (bounded cardinality):

```typescript
jobsSubmittedTotal
  .labels({
    queue: queue, // ~10 queues
    type: jobType, // ~50 types
    priority: priority, // 4 priorities
  })
  .inc();
```

### 2. Histogram Buckets

Choose buckets based on expected distribution:

```typescript
// API latency (milliseconds)
buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5];

// Job duration (seconds)
buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

// Queue depth (jobs)
buckets: [0, 10, 50, 100, 500, 1000, 5000, 10000];
```

### 3. Span Attributes

**❌ Bad** (too many/sensitive):

```typescript
span.setAttribute('user.email', 'user@example.com'); // PII!
span.setAttribute('payload', JSON.stringify(payload)); // Too large!
```

**✅ Good** (minimal/safe):

```typescript
span.setAttribute('job.id', jobId);
span.setAttribute('job.type', jobType);
span.setAttribute('job.queue', queue);
```

### 4. Error Handling

Always record errors in spans:

```typescript
try {
  // ... work
} catch (error) {
  recordError(span, error); // Records exception + sets ERROR status
  throw error;
} finally {
  endSpan(span);
}
```

### 5. Sampling

For high-traffic systems, use sampling:

```bash
# Sample 10% of traces
export OTEL_TRACES_SAMPLER=parentbased_traceidratio
export OTEL_TRACES_SAMPLER_ARG=0.1
```

## Performance Impact

### Metrics

- **Memory**: ~10MB for 70 metrics with typical cardinality
- **CPU**: <1% overhead for metric updates
- **Scrape latency**: 5-50ms depending on metric count

### Tracing

- **Memory**: ~1KB per span
- **CPU**: <2% overhead with 100% sampling
- **Network**: ~5KB per span over HTTP

**Recommendation**: Use 100% sampling in dev, 10-25% in production.

## Integration Examples

### API Server

```typescript
// apps/api/src/index.ts
import { initializeTracing } from '@taskflow/observability';

// Initialize tracing FIRST
initializeTracing('taskflow-api');

// Then start server
import('./app').then(({ createApp }) => {
  const app = createApp();
  app.listen({ port: 3000, host: '0.0.0.0' });
});
```

### Worker

```typescript
// apps/worker/src/index.ts
import {
  initializeTracing,
  JobTracing,
  workersActive,
} from '@taskflow/observability';

initializeTracing('taskflow-worker');

const worker = new Worker(config);

// Update metrics
workersActive.labels({ queue: 'default' }).inc();

// Trace job execution
await withSpan('processJob', { jobId }, async (span) => {
  JobTracing.recordJobStarted(jobId, workerId);
  await handler(job);
  JobTracing.recordJobCompleted(jobId, duration);
});
```

## Troubleshooting

### Metrics not appearing in Prometheus

1. Check `/metrics` endpoint returns data
2. Verify Prometheus scrape config
3. Check Prometheus targets page (Status → Targets)
4. Look for scrape errors in Prometheus logs

### Traces not appearing in Jaeger

1. Verify OTLP endpoint: `curl http://jaeger:4318/v1/traces`
2. Check application logs for tracing errors
3. Verify sampling rate (0.0 = no traces)
4. Check Jaeger collector logs

### High memory usage

1. Reduce metric cardinality (fewer label combinations)
2. Lower trace sampling rate
3. Use histogram/summary instead of tracking all values
4. Set appropriate retention in Prometheus

### High CPU usage

1. Increase Prometheus scrape interval (15s → 60s)
2. Reduce trace sampling rate (100% → 10%)
3. Use histogram pre-aggregation instead of raw observations
4. Disable auto-instrumentation selectively

## License

MIT
