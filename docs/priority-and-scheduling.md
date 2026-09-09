# Priority and Scheduling

## Overview

TaskFlow supports **priority-based job processing** and **delayed job execution** to handle different workload requirements. Jobs are processed in priority order, and future jobs are automatically enqueued when their scheduled time arrives.

## Priority Levels

### Priority Enum

```typescript
enum JobPriority {
  CRITICAL = 'CRITICAL',  // Urgent, process immediately
  HIGH = 'HIGH',          // Important, process soon
  NORMAL = 'NORMAL',      // Standard priority (default)
  LOW = 'LOW',            // Background, process when idle
}
```

### Priority Ordering

**Processing order**: `CRITICAL > HIGH > NORMAL > LOW`

When multiple jobs are queued:
1. Higher priority jobs are processed first
2. Within same priority, FIFO order (oldest first)
3. Workers can be configured to only process minimum priority levels

### Database Schema

```sql
CREATE TYPE job_priority AS ENUM ('CRITICAL', 'HIGH', 'NORMAL', 'LOW');

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  priority job_priority NOT NULL DEFAULT 'NORMAL',
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ...
);

-- Index for priority queries
CREATE INDEX idx_jobs_priority_created 
  ON jobs(priority DESC, created_at ASC)
  WHERE status = 'QUEUED';
```

## Job Scheduling

### Scheduled Execution

Jobs have a `scheduledAt` timestamp that controls when they become eligible for processing:

```typescript
// Immediate execution (default)
const job = await submitJob({
  type: 'send-email',
  payload: { to: 'user@example.com' },
  // scheduledAt defaults to now()
});

// Delayed execution (5 minutes from now)
const delayedJob = await submitJob({
  type: 'send-reminder',
  payload: { userId: '123' },
  scheduledAt: new Date(Date.now() + 5 * 60 * 1000),
});

// Scheduled for specific time
const scheduledJob = await submitJob({
  type: 'daily-report',
  payload: { date: '2024-01-01' },
  scheduledAt: new Date('2024-01-01T09:00:00Z'),
});
```

### Job Lifecycle

```
1. CREATED (scheduledAt = future)
   ↓
   [Scheduler polls database every 5s]
   ↓
2. QUEUED (when scheduledAt <= now())
   ↓
   [Worker consumes from Redis]
   ↓
3. PROCESSING
   ↓
4. SUCCEEDED / FAILED / DEAD_LETTERED
```

## Scheduler Service

### Architecture

The **Scheduler** is a background service that:
1. Polls database for `CREATED` jobs with `scheduledAt <= now()`
2. Enqueues them to Redis Streams
3. Updates status to `QUEUED`

```typescript
import { createScheduler } from '@taskflow/worker';

const scheduler = createScheduler({
  intervalMs: 5000,      // Poll every 5 seconds
  batchSize: 100,        // Process 100 jobs per batch
  enabled: true,         // Enable scheduler
});

scheduler.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  scheduler.stop();
});
```

### Implementation

```typescript
class Scheduler {
  private async runSchedulingCycle() {
    // 1. Get jobs ready to queue
    const jobs = await getJobsReadyToQueue(this.config.batchSize);

    // 2. Enqueue each job
    for (const job of jobs) {
      const queueName = job.metadata?.queue || 'default';
      
      // Add to Redis Stream
      await enqueueJob(job.id, queueName, 1);
      
      // Update status
      await updateJobStatus(job.id, 'QUEUED');
    }
  }
}
```

### Configuration

```typescript
interface SchedulerConfig {
  /**
   * Interval between scheduling runs (milliseconds)
   * Default: 5000 (5 seconds)
   * 
   * Trade-offs:
   * - Lower = More accurate timing, higher database load
   * - Higher = Less database load, less accurate timing
   */
  intervalMs?: number;

  /**
   * Maximum jobs to process per run
   * Default: 100
   * 
   * Prevents overwhelming Redis with batch inserts
   */
  batchSize?: number;

  /**
   * Enable/disable scheduler
   * Default: true
   * 
   * Disable for workers-only deployments
   */
  enabled?: boolean;
}
```

## Priority-Based Worker Configuration

### Worker Priority Filtering

Workers can be configured to only process jobs above a minimum priority:

```typescript
// Worker 1: Only CRITICAL jobs
const criticalWorker = createWorker(
  {
    workerId: 'critical-worker-1',
    queues: ['default'],
    concurrency: 5,
    minPriority: 'CRITICAL',
  },
  handlers
);

// Worker 2: CRITICAL and HIGH jobs
const highPriorityWorker = createWorker(
  {
    workerId: 'high-priority-worker-1',
    queues: ['default'],
    concurrency: 10,
    minPriority: 'HIGH',
  },
  handlers
);

// Worker 3: All jobs (default)
const standardWorker = createWorker(
  {
    workerId: 'standard-worker-1',
    queues: ['default'],
    concurrency: 10,
    // No minPriority = processes all jobs
  },
  handlers
);

// Worker 4: LOW priority only (background processing)
const backgroundWorker = createWorker(
  {
    workerId: 'background-worker-1',
    queues: ['default'],
    concurrency: 5,
    minPriority: 'LOW',
    maxPriority: 'LOW',  // TODO: Implement maxPriority
  },
  handlers
);
```

### Priority Ordering in Database

```typescript
/**
 * Get jobs ready to process (status = QUEUED, scheduledAt <= now)
 * Ordered by priority (DESC) then created time (ASC)
 */
export async function getJobsReadyToProcess(
  queueId: string,
  limit: number = 100
): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.queueId, queueId),
        eq(jobs.status, 'QUEUED'),
        lt(jobs.scheduledAt, new Date())
      )
    )
    .orderBy(desc(jobs.priority), asc(jobs.createdAt))
    .limit(limit);
}
```

## Use Cases

### 1. Different SLA Tiers

```typescript
// Premium user: CRITICAL
await submitJob({
  type: 'send-email',
  payload: { userId: 'premium-123' },
  priority: 'CRITICAL',
  metadata: { sla: '99.9%', maxLatencyMs: 1000 },
});

// Free user: NORMAL
await submitJob({
  type: 'send-email',
  payload: { userId: 'free-456' },
  priority: 'NORMAL',
  metadata: { sla: '95%', maxLatencyMs: 30000 },
});
```

### 2. Time-Sensitive Operations

```typescript
// Payment processing: CRITICAL
await submitJob({
  type: 'process-payment',
  payload: { orderId: '789' },
  priority: 'CRITICAL',
});

// Analytics: LOW
await submitJob({
  type: 'update-analytics',
  payload: { event: 'page_view' },
  priority: 'LOW',
});
```

### 3. Scheduled Jobs

```typescript
// Daily report at 9 AM
await submitJob({
  type: 'generate-daily-report',
  payload: { date: '2024-01-01' },
  scheduledAt: new Date('2024-01-01T09:00:00Z'),
  priority: 'HIGH',
});

// Send reminder in 1 hour
await submitJob({
  type: 'send-reminder',
  payload: { userId: '123', reminderType: 'meeting' },
  scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
  priority: 'NORMAL',
});

// Background cleanup at midnight
await submitJob({
  type: 'cleanup-old-data',
  payload: { olderThanDays: 90 },
  scheduledAt: new Date('2024-01-02T00:00:00Z'),
  priority: 'LOW',
});
```

### 4. Rate Limiting with Delays

```typescript
// Spread API calls over time
for (let i = 0; i < 100; i++) {
  await submitJob({
    type: 'call-third-party-api',
    payload: { requestId: i },
    scheduledAt: new Date(Date.now() + i * 1000), // 1 job per second
    priority: 'NORMAL',
  });
}
```

## Implementation Details

### Priority in Redis Streams

Redis Streams **do not natively support priority**. TaskFlow handles priority at the **database layer**:

1. Jobs enqueued to Redis in creation order (FIFO)
2. Worker polls database for `QUEUED` jobs ordered by priority
3. Worker consumes from Redis and processes by priority

**Why this approach?**
- PostgreSQL is already the source of truth
- Priority ordering requires sorting, which Redis Streams can't do efficiently
- Database query is fast with proper indexes
- Workers only process jobs they've acquired leases for

### Scheduling Precision

**Guarantee**: Jobs become eligible when `scheduledAt <= now()`

**Actual execution delay**:
```
Total Delay = Scheduler Polling Interval + Queue Processing Delay

Example:
- scheduledAt: 10:00:00
- Scheduler poll interval: 5s
- Scheduler runs at: 10:00:03
- Job enqueued at: 10:00:03
- Worker picks up job: 10:00:04
- Actual execution: 10:00:04

Delay = 4 seconds (acceptable for most use cases)
```

**For sub-second precision**: Use separate scheduling system (Temporal, Step Functions)

### Scheduler High Availability

**Single instance recommended**: Only one scheduler should run to avoid duplicate enqueues

**Future: Leader Election**
```typescript
// TODO: Implement leader election with Redis
class Scheduler {
  private async acquireLeadership(): Promise<boolean> {
    const result = await redis.set(
      'scheduler:leader',
      this.instanceId,
      'EX', 10,  // 10 second lease
      'NX'       // Only if not exists
    );
    return result === 'OK';
  }
}
```

## Monitoring

### Scheduler Metrics

```typescript
// Prometheus metrics
scheduler_runs_total                        // Total scheduling cycles
scheduler_jobs_scheduled_total{priority}    // Jobs enqueued by priority
scheduler_errors_total                      // Scheduling errors
scheduler_run_duration_seconds              // Time per cycle
scheduler_batch_size                        // Jobs per cycle
scheduler_lag_seconds                       // How late jobs are scheduled
```

### Priority Queue Depth

```typescript
// Jobs waiting by priority
queue_depth_by_priority{queue,priority}

// Example alerts
- alert: CriticalJobsBacklog
  expr: queue_depth_by_priority{priority="CRITICAL"} > 100
  for: 1m

- alert: SchedulerLag
  expr: scheduler_lag_seconds > 60
  for: 5m
```

### Worker Priority Stats

```typescript
// Jobs processed by worker and priority
worker_jobs_processed_total{worker_id,priority}

// Average processing time by priority
job_processing_duration_seconds{priority}
```

## Best Practices

### ✅ Do

1. **Use priority for business value**
   - CRITICAL: Revenue-generating, customer-facing, SLA-bound
   - HIGH: Important, time-sensitive
   - NORMAL: Standard operations (default)
   - LOW: Background, analytics, cleanup

2. **Set appropriate scheduler interval**
   - Most use cases: 5-10 seconds
   - High-precision: 1-2 seconds
   - Low-priority only: 30-60 seconds

3. **Monitor priority distribution**
   - Too many CRITICAL jobs → Everything is critical → Nothing is critical
   - Aim for 80% NORMAL, 15% HIGH, 5% CRITICAL, <1% LOW

4. **Use scheduled jobs for**
   - Recurring tasks (cron-like)
   - Delayed execution (retry with backoff)
   - Rate limiting (spread over time)
   - Time-based campaigns

5. **Deploy dedicated workers**
   - Separate worker pools for different priorities
   - Critical workers → high-spec instances
   - Low priority workers → spot instances

### ❌ Don't

1. **Don't abuse CRITICAL**
   - Not everything is critical
   - Overuse defeats the purpose
   - Leads to priority inflation

2. **Don't use for real-time**
   - Sub-second precision needed? Use WebSockets/Server-Sent Events
   - TaskFlow is for **async background jobs**

3. **Don't schedule too far in advance**
   - >1 month: Use a separate cron system
   - Database table grows with scheduled jobs

4. **Don't rely on exact timing**
   - Scheduler polling → inherent delay
   - Database queries → variable latency
   - Worker availability → processing delay

5. **Don't run multiple schedulers**
   - Race conditions
   - Duplicate enqueues
   - Use leader election if needed

## Comparison with Other Systems

### BullMQ

```typescript
// BullMQ: Priority in Redis using sorted sets
queue.add('job', payload, {
  priority: 1,  // Lower number = higher priority
  delay: 5000,  // Delay in milliseconds
});
```

**Differences**:
- BullMQ: Redis-native priority with sorted sets
- TaskFlow: Database-backed priority with proper ordering
- BullMQ: Built-in delayed jobs with Redis TTL
- TaskFlow: Scheduler service for delayed jobs

**Why TaskFlow approach?**
- Database is source of truth (ADR-001)
- Priority needs strong consistency
- Delayed jobs need durability
- Redis Streams don't support priority natively

### Celery

```python
# Celery: Priority via separate queues
@app.task(queue='critical')
def critical_task():
    pass

@app.task(queue='normal')
def normal_task():
    pass
```

**Differences**:
- Celery: Separate queues per priority
- TaskFlow: Single queue with priority field
- Celery: Workers subscribe to specific queues
- TaskFlow: Workers filter by minPriority

### Temporal

```typescript
// Temporal: No built-in priority, use task queues
await client.workflow.start('myWorkflow', {
  taskQueue: 'critical-queue',
  // Schedule for later
  startDelay: '5m',
});
```

**Differences**:
- Temporal: Workflow orchestration, not job queue
- TaskFlow: Job queue with priority
- Temporal: Deterministic execution
- TaskFlow: At-least-once delivery

## Production Deployment

### Scheduler Deployment

```yaml
# Kubernetes Deployment (single replica)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: taskflow-scheduler
spec:
  replicas: 1  # Only one scheduler instance
  template:
    spec:
      containers:
      - name: scheduler
        image: taskflow-scheduler:latest
        env:
        - name: SCHEDULER_INTERVAL_MS
          value: "5000"
        - name: SCHEDULER_BATCH_SIZE
          value: "100"
        resources:
          requests:
            memory: 128Mi
            cpu: 100m
          limits:
            memory: 256Mi
            cpu: 200m
```

### Worker Deployment

```yaml
# Critical workers (high priority)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: taskflow-worker-critical
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: worker
        image: taskflow-worker:latest
        env:
        - name: WORKER_MIN_PRIORITY
          value: "CRITICAL"
        - name: WORKER_CONCURRENCY
          value: "5"
        resources:
          requests:
            memory: 512Mi
            cpu: 500m

---
# Standard workers (all priorities)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: taskflow-worker-standard
spec:
  replicas: 10
  template:
    spec:
      containers:
      - name: worker
        image: taskflow-worker:latest
        env:
        - name: WORKER_CONCURRENCY
          value: "10"
        resources:
          requests:
            memory: 256Mi
            cpu: 250m
```

## Future Enhancements

### 1. Dynamic Priority

```typescript
// Priority can increase over time (starvation prevention)
await submitJob({
  type: 'send-email',
  payload: {},
  priority: 'LOW',
  metadata: {
    priorityBoostAfterMinutes: 60,  // Boost to NORMAL after 1 hour
    maxPriority: 'NORMAL',
  },
});
```

### 2. Priority Inheritance

```typescript
// Child jobs inherit parent priority
const parentJob = await submitJob({
  type: 'process-order',
  priority: 'CRITICAL',
});

// Automatically CRITICAL
const childJob = await submitJob({
  type: 'send-confirmation',
  parentJobId: parentJob.id,
});
```

### 3. Weighted Fair Queuing

```typescript
// Process proportionally by priority
// CRITICAL: 50%, HIGH: 30%, NORMAL: 15%, LOW: 5%
const worker = createWorker({
  priorityWeights: {
    CRITICAL: 50,
    HIGH: 30,
    NORMAL: 15,
    LOW: 5,
  },
});
```

## Summary

TaskFlow's priority and scheduling system provides:

✅ **4 priority levels** (CRITICAL, HIGH, NORMAL, LOW)  
✅ **Database-backed ordering** with proper indexes  
✅ **Delayed job execution** via scheduler service  
✅ **Worker priority filtering** (minPriority config)  
✅ **Strong consistency** (PostgreSQL source of truth)  
✅ **Production-ready** monitoring and deployment  

This enables differentiated service levels, time-based execution, and efficient resource allocation for diverse workload requirements.

## License

MIT
