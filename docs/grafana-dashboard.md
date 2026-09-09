# Grafana Dashboard

## Overview

Resilient TaskFlow includes a production-ready Grafana dashboard for monitoring distributed task queue operations. The dashboard provides real-time visibility into job throughput, queue health, worker status, and system performance.

**Location**: `/infrastructure/grafana/provisioning/dashboards/taskflow-overview.json`

**Dashboard UID**: `taskflow-overview`

---

## Dashboard Sections

### 1. System Overview (Row 1)

**Purpose**: High-level health indicators

**Panels**:
- **Total Jobs** (Stat): Current count of all jobs in system
- **Active Workers** (Stat): Number of workers currently processing jobs
  - Green: ≥ 1 worker
  - Red: 0 workers (critical)
- **Queue Depth** (Stat): Total jobs waiting in all queues
  - Green: < 100 jobs
  - Yellow: 100-999 jobs
  - Red: ≥ 1000 jobs
- **Job Success Rate** (Time Series): Real-time success percentage
  - Formula: `completed / (completed + failed) * 100`

**Why These Metrics?**
- Instant system health assessment
- Identifies worker outages immediately
- Detects queue backlog growth
- Tracks overall system reliability

---

### 2. Job Throughput (Row 2)

**Purpose**: Track job processing rates and identify bottlenecks

**Panels**:

#### Job Throughput by Queue (12-column Time Series)
- **Metric**: `rate(taskflow_jobs_*_total[5m])`
- **Lines**:
  - Submitted (blue): Jobs entering system
  - Completed (green): Successfully processed jobs
  - Failed (red): Jobs that failed

**What to Look For**:
- ✅ Submitted ≈ Completed: Healthy processing
- ⚠️ Submitted > Completed: Queue backlog growing
- ⚠️ High failure rate: Job or dependency issues

**Calculations**:
- **Mean**: Average throughput over time
- **Last**: Current throughput

**Use Cases**:
- Capacity planning: Can we handle load?
- Incident detection: Sudden throughput drop
- Scaling decisions: Need more workers?

#### Current Jobs by Status (12-column Stacked Time Series)
- **Metric**: `taskflow_jobs_current{status=~"queued|running|failed"}`
- **Stack**:
  - Queued (yellow): Waiting for processing
  - Running (blue): Currently executing
  - Failed (red): Permanent failures

**What to Look For**:
- ✅ Running stable: Workers keeping up
- ⚠️ Queued growing: Need more capacity
- ⚠️ Failed accumulating: Investigate errors

---

### 3. Latency & Performance (Row 3)

**Purpose**: Measure job execution speed and identify performance degradation

**Panels**:

#### Job Duration Percentiles (12-column Time Series)
- **Metric**: `histogram_quantile(0.XX, rate(taskflow_job_duration_seconds_bucket[5m]))`
- **Percentiles**:
  - **P50 (Median)**: Typical job duration
  - **P95**: 95% of jobs complete within this time
  - **P99**: 99% of jobs complete within this time

**Why Percentiles?**
- **Average hides outliers**: P50 is more representative
- **P95/P99 catch long tail**: Identifies slow jobs
- **SLA enforcement**: "95% of jobs < 30s"

**What to Look For**:
- ✅ Stable percentiles: Consistent performance
- ⚠️ P95/P99 spike: Some jobs taking too long
- ⚠️ All percentiles increase: System-wide slowdown

**Example Interpretation**:
```
P50: 2s   → Half of jobs finish in 2 seconds
P95: 10s  → 95% finish in 10 seconds
P99: 30s  → 99% finish in 30 seconds (1% outliers)
```

#### Job Wait Time Percentiles (12-column Time Series)
- **Metric**: `histogram_quantile(0.XX, rate(taskflow_job_wait_duration_seconds_bucket[5m]))`
- **Measures**: Time from submission to start

**What to Look For**:
- ✅ Low wait time: Workers available
- ⚠️ High wait time: Queue backlog, need more workers
- ⚠️ Increasing trend: System falling behind

---

### 4. Queue Health (Row 4)

**Purpose**: Monitor queue backlog and detect stuck jobs

**Panels**:

#### Queue Depth by Priority (12-column Time Series)
- **Metric**: `taskflow_queue_depth{priority=~"CRITICAL|HIGH|NORMAL|LOW"}`
- **Lines**:
  - Critical (red): Highest priority
  - High (orange): High priority
  - Normal (blue): Standard priority
  - Low (green): Background jobs

**What to Look For**:
- ✅ Critical/High near zero: Priority jobs processed quickly
- ⚠️ Critical queue growing: Urgent, add workers
- ⚠️ Normal/Low backlog: Acceptable if not growing

**Priority Strategy**:
- Critical: Financial transactions, time-sensitive ops
- High: User-facing operations
- Normal: Standard background jobs
- Low: Analytics, cleanup, batch jobs

**Thresholds**:
- Green: < 100 jobs
- Yellow: 100-1000 jobs
- Red: > 1000 jobs

#### Queue Lag (Age of Oldest Job) (12-column Time Series)
- **Metric**: `taskflow_queue_lag_seconds`
- **Measures**: How long oldest job has been waiting

**What to Look For**:
- ✅ Lag < 10s: Jobs processed quickly
- ⚠️ Lag 10-60s: Backlog, monitor closely
- ⚠️ Lag > 60s: Jobs stuck, investigate

**Causes of High Lag**:
- Insufficient workers
- Worker crashes
- Long-running jobs blocking queue
- Database/Redis slow

**Thresholds**:
- Green: < 30s
- Yellow: 30-60s
- Red: > 60s

---

### 5. Worker Health (Row 5)

**Purpose**: Monitor worker availability and failures

**Panels**:

#### Worker Activity (12-column Time Series)
- **Metrics**:
  - `taskflow_workers_active`: Number of active workers
  - `sum(taskflow_worker_jobs_concurrent)`: Total jobs being processed

**What to Look For**:
- ✅ Workers > 0: System operational
- ⚠️ Workers = 0: Critical, no processing
- ✅ Concurrent jobs < worker_count * concurrency: Capacity available
- ⚠️ Concurrent jobs = max capacity: Fully utilized

**Example**:
```
Workers: 5
Concurrency per worker: 10
Max capacity: 5 * 10 = 50 jobs

Current concurrent: 48 → 96% utilization (near max)
```

#### Worker Failures (12-column Time Series)
- **Metrics**:
  - `rate(taskflow_worker_failures_total[5m])`: Worker crashes
  - `rate(taskflow_worker_lease_acquisition_failures_total[5m])`: Lease failures

**What to Look For**:
- ✅ Zero failures: Healthy workers
- ⚠️ Occasional failures: Transient issues (acceptable)
- ⚠️ Frequent failures: Investigate root cause

**Common Failure Causes**:
- OOM (Out of Memory): Reduce concurrency
- Database connection exhaustion: Increase pool size
- Job handler bugs: Fix application code
- Lease contention: Too many workers for job rate

---

### 6. API Performance (Row 6)

**Purpose**: Monitor API health and client experience

**Panels**:

#### API Request Rate (12-column Time Series)
- **Metric**: `rate(taskflow_http_requests_total{status=~"2..|4..|5.."}[5m])`
- **Lines**:
  - 2xx (green): Successful requests
  - 4xx (yellow): Client errors (bad requests)
  - 5xx (red): Server errors (critical)

**What to Look For**:
- ✅ Mostly 2xx: Healthy API
- ⚠️ High 4xx: Client integration issues
- ⚠️ Any 5xx: Server problems, investigate

**Common 4xx Errors**:
- 400: Bad request (malformed JSON)
- 401: Unauthorized (missing/invalid API key)
- 429: Rate limited (too many requests)

**Common 5xx Errors**:
- 500: Internal server error (uncaught exception)
- 503: Service unavailable (database down)

#### API Latency Percentiles (12-column Time Series)
- **Metric**: `histogram_quantile(0.XX, rate(taskflow_http_request_duration_seconds_bucket[5m]))`
- **Percentiles**: P50, P95, P99

**What to Look For**:
- ✅ P95 < 100ms: Excellent performance
- ✅ P95 < 500ms: Good performance
- ⚠️ P95 > 1s: Slow, investigate

**Latency Breakdown**:
- P50 = 20ms: Most requests fast
- P95 = 100ms: 95% acceptable
- P99 = 500ms: 1% outliers (complex queries, retries)

---

## PromQL Queries Reference

### Job Throughput
```promql
# Jobs submitted per second
rate(taskflow_jobs_submitted_total[5m])

# Jobs completed per second
rate(taskflow_jobs_completed_total[5m])

# Job success rate (%)
rate(taskflow_jobs_completed_total[5m]) 
/ 
(rate(taskflow_jobs_completed_total[5m]) + rate(taskflow_jobs_failed_total[5m])) 
* 100
```

### Latency Percentiles
```promql
# P50 job duration
histogram_quantile(0.50, rate(taskflow_job_duration_seconds_bucket[5m]))

# P95 job duration
histogram_quantile(0.95, rate(taskflow_job_duration_seconds_bucket[5m]))

# P99 job duration
histogram_quantile(0.99, rate(taskflow_job_duration_seconds_bucket[5m]))
```

### Queue Health
```promql
# Queue depth by priority
taskflow_queue_depth{priority="CRITICAL"}
taskflow_queue_depth{priority="HIGH"}

# Queue backlog growth rate (jobs/sec)
deriv(taskflow_queue_depth[5m])

# Queue lag (age of oldest job)
taskflow_queue_lag_seconds
```

### Worker Health
```promql
# Active workers
taskflow_workers_active

# Worker utilization (%)
(sum(taskflow_worker_jobs_concurrent) / (taskflow_workers_active * 10)) * 100

# Worker failure rate
rate(taskflow_worker_failures_total[5m])
```

### API Performance
```promql
# API request rate (req/sec)
rate(taskflow_http_requests_total[5m])

# P95 API latency
histogram_quantile(0.95, rate(taskflow_http_request_duration_seconds_bucket[5m]))

# Error rate (%)
rate(taskflow_http_requests_total{status=~"5.."}[5m]) 
/ 
rate(taskflow_http_requests_total[5m]) 
* 100
```

---

## Dashboard Usage

### Accessing the Dashboard

**Local Development**:
```bash
# Start services
docker-compose up -d

# Access Grafana
open http://localhost:3001

# Default credentials
Username: admin
Password: admin (change on first login)
```

**Dashboard Location**:
- Navigate to **Dashboards** → **TaskFlow - System Overview**
- Or direct URL: `http://localhost:3001/d/taskflow-overview`

### Time Range

**Default**: Last 1 hour

**Recommended for Different Scenarios**:
- **Real-time monitoring**: Last 5 minutes (refresh 5s)
- **Incident investigation**: Last 1 hour
- **Capacity planning**: Last 7 days
- **Performance analysis**: Last 30 days

### Auto-Refresh

**Default**: 10 seconds

**Options**:
- 5s: Real-time monitoring (high load)
- 10s: Standard monitoring
- 30s: Reduce Prometheus load
- Off: Historical analysis

---

## Alerting Integration

### Prometheus Alerts (Example)

```yaml
# High job failure rate
- alert: HighJobFailureRate
  expr: |
    rate(taskflow_jobs_failed_total[5m])
    / rate(taskflow_jobs_completed_total[5m] + taskflow_jobs_failed_total[5m])
    > 0.1
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Job failure rate > 10%"
    dashboard: "http://grafana:3001/d/taskflow-overview"

# No active workers
- alert: NoActiveWorkers
  expr: taskflow_workers_active == 0
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "No active workers detected"
    dashboard: "http://grafana:3001/d/taskflow-overview"

# High queue backlog
- alert: HighQueueBacklog
  expr: taskflow_queue_depth > 1000
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Queue depth > 1000 jobs"
    dashboard: "http://grafana:3001/d/taskflow-overview"
```

**Alert → Dashboard Flow**:
1. Alert fires in Prometheus
2. Alertmanager sends notification (Slack, PagerDuty)
3. Notification includes dashboard link
4. Engineer clicks link → Opens dashboard at incident time
5. Dashboard shows metrics before/during/after incident

---

## Dashboard Customization

### Adding New Panels

**1. Clone existing panel**:
- Click panel title → **More** → **Duplicate**
- Edit query and visualization

**2. Create from scratch**:
- **Add** → **Visualization**
- Select data source: Prometheus
- Enter PromQL query
- Configure visualization (Time Series, Stat, Gauge, etc.)

### Common Customizations

**1. Add queue-specific view**:
```promql
# Filter by specific queue
rate(taskflow_jobs_completed_total{queue="email"}[5m])
```

**2. Add job type breakdown**:
```promql
# Group by job type
sum by (type) (rate(taskflow_jobs_submitted_total[5m]))
```

**3. Add worker-specific view**:
```promql
# Per-worker metrics
taskflow_worker_jobs_concurrent{worker_id="worker-1"}
```

**4. Add custom thresholds**:
- **Edit panel** → **Thresholds**
- Set values and colors (green/yellow/red)

---

## Troubleshooting

### Dashboard Not Loading

**Symptom**: Blank dashboard or "No data"

**Checks**:
1. Prometheus running: `curl http://localhost:9090/api/v1/targets`
2. API exposing metrics: `curl http://localhost:3000/metrics`
3. Grafana datasource: **Configuration** → **Data Sources** → **Prometheus**
4. Query Inspector: **Panel title** → **Inspect** → **Query**

### Metrics Not Appearing

**Symptom**: Specific panels show "No data"

**Causes**:
- **Metric not scraped**: Check Prometheus targets
- **No data yet**: System hasn't generated metric (wait for activity)
- **Wrong label**: Check label names in query
- **Time range**: Metric exists but outside time range

**Debug**:
```bash
# Check if metric exists in Prometheus
curl 'http://localhost:9090/api/v1/query?query=taskflow_jobs_submitted_total'

# Check metric labels
curl 'http://localhost:9090/api/v1/label/__name__/values' | grep taskflow
```

### High Cardinality Warning

**Symptom**: "Series cardinality too high" warning

**Cause**: Too many unique label combinations

**Fix**:
```promql
# ❌ Bad (unbounded cardinality)
taskflow_jobs_submitted_total{user_id="user123"}

# ✅ Good (bounded cardinality)
taskflow_jobs_submitted_total{queue="default", type="email"}
```

---

## Best Practices

### 1. Dashboard Organization

**Row per concern**:
- System overview (high-level)
- Job throughput (core functionality)
- Latency (performance)
- Queue health (capacity)
- Worker health (reliability)
- API performance (client experience)

**Panel per metric**:
- One clear question per panel
- Use titles that explain what to look for
- Add descriptions for complex metrics

### 2. Time Series vs Stat

**Use Time Series for**:
- Trends over time
- Comparing multiple metrics
- Identifying patterns (spikes, drops, cycles)

**Use Stat for**:
- Current value (right now)
- Threshold-based alerting (green/yellow/red)
- Quick glance metrics (total jobs, active workers)

### 3. Color Coding

**Standard**:
- Green: Healthy, normal operation
- Yellow: Warning, investigate if persists
- Red: Critical, immediate action required

**Apply thresholds**:
- Queue depth: < 100 (green), 100-1000 (yellow), > 1000 (red)
- Success rate: > 95% (green), 90-95% (yellow), < 90% (red)
- Active workers: > 0 (green), = 0 (red)

### 4. Refresh Rate

**Production**:
- Standard monitoring: 10-30s
- Incident response: 5s
- Historical analysis: Off (save resources)

**Balance**:
- Faster refresh = Higher Prometheus load
- 5s refresh acceptable for < 100 metrics per panel

---

## Production Checklist

Before deploying to production:

- [ ] Dashboard imported successfully
- [ ] All panels showing data
- [ ] Time range set appropriately (1h default)
- [ ] Auto-refresh enabled (10s)
- [ ] Alert annotations configured
- [ ] Custom alerts linked to dashboard
- [ ] Team trained on dashboard usage
- [ ] Incident runbook includes dashboard link
- [ ] Backup dashboard JSON saved
- [ ] Grafana authentication configured

---

## Summary

**What We Built**:
- ✅ Production-ready Grafana dashboard
- ✅ 6 monitoring sections covering entire system
- ✅ 12+ panels with engineering-focused visualizations
- ✅ Real-time metrics with 10s auto-refresh
- ✅ Percentile-based performance tracking
- ✅ Queue health and backlog monitoring
- ✅ Worker failure detection
- ✅ API performance tracking

**Key Features**:
- **System Overview**: Health at a glance
- **Job Throughput**: Processing rates and capacity
- **Latency Tracking**: P50/P95/P99 percentiles
- **Queue Health**: Backlog and priority monitoring
- **Worker Health**: Availability and failures
- **API Performance**: Request rates and latency

**Interview Points**:
- Why percentiles? More reliable than averages (hide outliers)
- Why separate panels? Each answers one question clearly
- Why time series? Trends reveal patterns (spikes, drops, cycles)
- Dashboard design? Engineering-focused, not marketing fluff
- Alert integration? Dashboard linked in alert notifications

---

**Status**: ✅ Phase 14 Complete

**Next**: Phase 15 (Testing - unit, integration, E2E, failure tests)
