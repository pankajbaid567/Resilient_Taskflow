# Load Testing Guide

This guide covers load testing for Resilient TaskFlow using k6, an open-source load testing tool built for engineering teams.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Test Scenarios](#test-scenarios)
- [Metrics and Thresholds](#metrics-and-thresholds)
- [Running Tests](#running-tests)
- [Interpreting Results](#interpreting-results)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [CI/CD Integration](#cicd-integration)

## Overview

### Why k6?

k6 is a modern load testing tool that:
- Uses JavaScript for test scripts (accessible to developers)
- Provides excellent performance (thousands of VUs on a single machine)
- Generates detailed metrics (P95, P99 latency, throughput, error rates)
- Integrates with monitoring systems (Prometheus, Grafana)
- Supports multiple test types (sustained, spike, stress, soak)

### Test Philosophy

Our load tests follow these principles:

1. **Realistic Scenarios**: Simulate actual user behavior, not just request flooding
2. **Gradual Ramp-up**: Start slow, ramp to peak, sustain, then ramp down
3. **Clear Success Criteria**: Define thresholds before running tests
4. **Comprehensive Coverage**: Test sustained load, spikes, scaling, and mixed workloads
5. **Actionable Results**: Generate reports that guide optimization decisions

### Test Suite Architecture

```
tests/load/
├── utils.js                    # Shared utilities and API client
├── sustained-load.test.js      # Steady-state performance test
├── spike-load.test.js          # Traffic spike recovery test
├── worker-scaling.test.js      # Worker scaling validation test
├── mixed-workload.test.js      # Realistic multi-scenario test
├── scale-workers.js            # Automated worker scaling script
├── results/                    # Test result reports (HTML, JSON)
└── README.md                   # Quick reference guide
```

## Installation

### macOS

```bash
brew install k6
```

### Linux (Debian/Ubuntu)

```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### Linux (Fedora/CentOS)

```bash
sudo dnf install https://dl.k6.io/rpm/repo.rpm
sudo dnf install k6
```

### Windows

```bash
choco install k6
```

### Docker

```bash
docker pull grafana/k6:latest
```

### Verify Installation

```bash
k6 version
```

## Quick Start

### 1. Start the System

```bash
# Start all services
docker-compose up -d

# Wait for services to be ready
sleep 10

# Check health
curl http://localhost:3000/health
```

### 2. Run a Load Test

```bash
# Run sustained load test (5 minutes)
pnpm load:sustained

# Or use k6 directly
k6 run tests/load/sustained-load.test.js
```

### 3. View Results

Test results are saved to `tests/load/results/`:
- `sustained-load-<timestamp>.html` - Visual report
- `sustained-load-<timestamp>.json` - Raw data

Open the HTML report in your browser:

```bash
open tests/load/results/sustained-load-*.html
```

## Test Scenarios

### 1. Sustained Load Test

**Purpose**: Measure steady-state performance under sustained load.

**Duration**: 5 minutes

**Load Pattern**:
```
VUs
50 |         ___________
   |        /           \
10 |   ____/             \____
   |  /                       \
 0 |_/                         \_
   0  1  2  3  4  5  6  7  8  9 min
```

**What It Tests**:
- System handles sustained traffic without degradation
- Latency remains stable over time
- No memory leaks or resource exhaustion
- Queue depth stays manageable
- Success rate remains high (>99%)

**Success Criteria**:
- P95 latency < 500ms
- P99 latency < 1000ms
- Error rate < 1%
- Queue depth < 500 jobs

**Run**:
```bash
pnpm load:sustained
```

**Key Metrics to Watch**:
- `http_req_duration` (P95, P99)
- `http_req_failed` (error rate)
- `job_submission_duration`
- `queue_depth`

### 2. Spike Load Test

**Purpose**: Test system recovery from sudden traffic spikes.

**Duration**: 4 minutes

**Load Pattern**:
```
VUs
100|         ____
   |        |    |
   |        |    |
10 |   ____|    |____
   |  /              \
 0 |_/                \_
   0  1  2  3  4  5  6 min
```

**What It Tests**:
- System handles sudden 10x traffic increase
- Error rate remains acceptable during spike
- System recovers gracefully after spike
- No cascading failures
- Queue backlog clears after spike

**Success Criteria**:
- P95 latency < 1000ms (during spike)
- P99 latency < 2000ms (during spike)
- Error rate < 5% (during spike)
- Queue depth < 2000 jobs

**Run**:
```bash
pnpm load:spike
```

**Key Metrics to Watch**:
- Max latency during spike
- Error rate spike (should be temporary)
- Queue depth (should recover after spike)
- Recovery time (how fast queue drains)

### 3. Worker Scaling Test

**Purpose**: Validate system scales linearly with worker count.

**Duration**: 10 minutes

**Load Pattern**:
```
Jobs/s: 50 (constant)

Workers:
10 |         ____
   |        /    \
 5 |   ____/      \____
   |  /                \
 1 |_/                  \___
   0  2  4  6  8 10 min
```

**What It Tests**:
- Job throughput increases with worker count
- Queue depth decreases as workers are added
- System gracefully handles worker removal
- No job loss during worker scaling
- Leases properly transfer between workers

**Success Criteria**:
- Throughput scales with worker count
- No job loss (DB count = submitted count)
- Queue drains with 10 workers
- Queue backs up with 1 worker

**Run**:
```bash
# Terminal 1: Run the test
pnpm load:scaling

# Terminal 2: Run the scaling automation
node tests/load/scale-workers.js
```

**Scaling Schedule**:
- 0:00 - 2:00 → 1 worker (baseline, queue backs up)
- 2:00 - 4:00 → 5 workers (queue drains)
- 4:00 - 6:00 → 10 workers (queue clears quickly)
- 6:00 - 8:00 → 5 workers (queue may grow slightly)
- 8:00 - 10:00 → 1 worker (queue backs up again)

**Key Metrics to Watch**:
- Queue depth vs. worker count correlation
- Jobs per second throughput
- No errors during scaling events

### 4. Mixed Workload Test

**Purpose**: Simulate realistic production traffic patterns.

**Duration**: 5 minutes

**Load Pattern**:
```
5 concurrent scenarios with different behaviors:

1. Normal Users (70% load)      - 0→20 VUs, mixed priorities
2. Urgent Jobs (15% load)        - 10 jobs/s, HIGH/CRITICAL
3. Batch Processing (10% load)   - 5 VUs, LOW priority, large payloads
4. Scheduled Jobs (5% load)      - 2 jobs/s, future execution
5. Monitoring (constant)         - 3 VUs, read-heavy queries
```

**What It Tests**:
- System handles mixed priorities correctly
- Different job types coexist without interference
- Scheduled jobs and immediate jobs work together
- Cancellations work under load
- Read operations don't impact write performance
- Realistic user behavior patterns

**Success Criteria**:
- P95 latency < 600ms (overall)
- P99 latency < 1200ms (overall)
- Error rate < 1%
- Urgent jobs have lower latency than batch jobs

**Run**:
```bash
pnpm load:mixed
```

**Key Metrics to Watch**:
- Per-scenario latency (urgent should be fastest)
- Priority queue ordering (CRITICAL > HIGH > NORMAL > LOW)
- Mixed read/write performance
- No starvation of low-priority jobs

## Metrics and Thresholds

### Standard k6 Metrics

k6 tracks these metrics automatically:

| Metric | Description | Good Value |
|--------|-------------|------------|
| `http_req_duration` | Request latency | P95 < 500ms, P99 < 1s |
| `http_req_failed` | Failed request rate | < 1% |
| `http_reqs` | Total requests per second | Depends on test |
| `vus` | Virtual users (concurrent) | Depends on test |
| `iterations` | Total iterations completed | Depends on test |

### Custom Metrics

We track additional application-specific metrics:

| Metric | Description | Good Value |
|--------|-------------|------------|
| `job_submission_duration` | Time to submit a job | P95 < 200ms |
| `job_completion_duration` | End-to-end job time | P95 < 5s |
| `queue_depth` | Current queue backlog | < 500 jobs |
| `queue_depth_critical` | CRITICAL priority queue | < 10 jobs |
| `active_workers` | Number of active workers | Depends on config |
| `jobs_per_second` | Job throughput | Depends on workers |

### Threshold Configuration

Thresholds define pass/fail criteria. Tests fail if thresholds are not met.

**Common Thresholds**:
```javascript
thresholds: {
  'http_req_duration': ['p(95)<500', 'p(99)<1000'],
  'http_req_failed': ['rate<0.01'],
  'job_submission_duration': ['p(95)<200'],
  'queue_depth': ['value<500'],
}
```

**Spike Test Thresholds** (more relaxed):
```javascript
thresholds: {
  'http_req_duration': ['p(95)<1000', 'p(99)<2000'],
  'http_req_failed': ['rate<0.05'], // 5% during spike
  'queue_depth': ['value<2000'],
}
```

### Percentiles Explained

**Why percentiles over averages?**

Averages hide outliers. P95/P99 show what most users experience:

- **P50 (median)**: 50% of requests faster, 50% slower
- **P95**: 95% of requests faster (only 5% slower)
- **P99**: 99% of requests faster (only 1% slower)
- **P99.9**: 99.9% of requests faster (0.1% outliers)

**Example**:
```
Average latency: 150ms  (looks good!)
P99 latency: 3000ms     (1% of users wait 3 seconds!)
```

P99 reveals the "long tail" that averages hide.

## Running Tests

### Basic Usage

```bash
# Run a specific test
k6 run tests/load/sustained-load.test.js

# Use npm scripts (recommended)
pnpm load:sustained
pnpm load:spike
pnpm load:scaling
pnpm load:mixed

# Run all tests sequentially
pnpm load:all
```

### Environment Variables

Customize test parameters:

```bash
# Custom API URL
K6_API_URL=http://staging.example.com:3000 k6 run tests/load/sustained-load.test.js

# Custom duration (for sustained test)
K6_DURATION=10m k6 run tests/load/sustained-load.test.js

# Custom VUs (virtual users)
K6_VUS=100 k6 run tests/load/sustained-load.test.js

# Custom API key
K6_API_KEY=my-api-key k6 run tests/load/sustained-load.test.js
```

### Docker Usage

Run tests from Docker:

```bash
docker run --rm -i \
  --network host \
  -v $PWD:/tests \
  grafana/k6:latest \
  run /tests/tests/load/sustained-load.test.js
```

### Output Formats

```bash
# Console output only (default)
k6 run tests/load/sustained-load.test.js

# Save results to JSON
k6 run --out json=results.json tests/load/sustained-load.test.js

# Send metrics to InfluxDB
k6 run --out influxdb=http://localhost:8086/k6 tests/load/sustained-load.test.js

# Send metrics to Prometheus
k6 run --out experimental-prometheus-rw tests/load/sustained-load.test.js
```

### Monitoring During Tests

While tests run, monitor the system:

```bash
# Watch Grafana dashboard
open http://localhost:3001/d/taskflow-overview

# Watch logs
docker-compose logs -f api worker

# Watch queue depth
watch -n 1 'curl -s http://localhost:3000/api/queues/default/stats | jq .total'

# Watch worker count
watch -n 1 'curl -s http://localhost:3000/api/workers | jq ".workers | length"'
```

## Interpreting Results

### Console Output

k6 displays results at the end of each test:

```
     ✓ http_req_duration..........: avg=120ms min=50ms med=110ms max=450ms p(95)=250ms p(99)=400ms
     ✓ http_req_failed............: 0.05% ✓ 25 ✗ 49975
     ✓ http_reqs..................: 50000 (500/s)
       iterations.................: 10000
       vus........................: 50 max=50
```

### Success Indicators

✅ **Good Performance**:
```
http_req_duration..........: avg=120ms  p(95)=250ms  p(99)=400ms  ✓
http_req_failed............: 0.05% ✓
http_reqs..................: 500/s
queue_depth................: 120
```

⚠️ **Degraded Performance**:
```
http_req_duration..........: avg=450ms  p(95)=800ms  p(99)=1200ms  ✗
http_req_failed............: 2.5% ✗
http_reqs..................: 150/s
queue_depth................: 1850
```

### HTML Reports

Open the generated HTML report for visual analysis:

```bash
open tests/load/results/sustained-load-*.html
```

The report includes:
- Request rate over time
- Latency percentiles over time
- Error rate visualization
- VU count graph
- Detailed metrics table

### JSON Results

For programmatic analysis:

```bash
# View JSON results
cat tests/load/results/sustained-load-*.json | jq .

# Extract specific metrics
cat results.json | jq '.metrics.http_req_duration.values["p(95)"]'

# Compare multiple test runs
diff <(jq . test1.json) <(jq . test2.json)
```

### Grafana Correlation

Correlate load test results with system metrics:

1. Note the test start/end timestamps
2. Open Grafana dashboard
3. Adjust time range to test window
4. Observe:
   - Queue depth trends
   - Worker CPU/memory usage
   - Database connection pool
   - Redis memory usage
   - Job throughput rates

### Common Patterns

**Pattern 1: Queue Backup**
```
Symptom: Queue depth grows continuously
Cause: Workers can't keep up with submission rate
Fix: Add more workers or optimize job processing
```

**Pattern 2: Latency Spikes**
```
Symptom: P99 >> P95, high max latency
Cause: Database slow queries or connection exhaustion
Fix: Add database indexes, increase connection pool
```

**Pattern 3: Error Rate Increase**
```
Symptom: http_req_failed > 1%
Cause: Rate limiting, timeouts, or backend errors
Fix: Check logs, adjust rate limits, scale backend
```

**Pattern 4: Memory Leak**
```
Symptom: Performance degrades over time
Cause: Memory not being released
Fix: Profile with heap snapshots, fix leaks
```

## Best Practices

### Test Preparation

1. **Establish Baseline**: Run tests on empty system first
2. **Clean Between Tests**: Clear queue and restart workers
3. **Warm Up**: Allow 30s warmup before measuring
4. **Isolate Tests**: Run one scenario at a time
5. **Monitor System**: Watch Grafana during tests

### Test Execution

1. **Start Small**: Begin with low VUs, increase gradually
2. **Realistic Think Time**: Add delays between requests
3. **Randomize Data**: Use different job types and payloads
4. **Check Health First**: Verify system healthy before test
5. **Save Results**: Always save HTML/JSON reports

### Result Analysis

1. **Focus on Percentiles**: P95/P99 > averages
2. **Correlate with Monitoring**: Check Grafana for system metrics
3. **Investigate Failures**: Review logs for error patterns
4. **Compare Over Time**: Track performance trends
5. **Document Findings**: Record insights and action items

### Performance Goals

For production readiness, aim for:

| Metric | Target | Acceptable | Poor |
|--------|--------|------------|------|
| P95 Latency | < 300ms | < 500ms | > 500ms |
| P99 Latency | < 500ms | < 1000ms | > 1000ms |
| Success Rate | > 99.9% | > 99% | < 99% |
| Throughput | > 100 jobs/s | > 50 jobs/s | < 50 jobs/s |
| Queue Depth | < 100 | < 500 | > 500 |

### Optimization Workflow

1. **Measure**: Run baseline load test
2. **Identify**: Find bottleneck (DB, Redis, CPU, network)
3. **Hypothesize**: Predict impact of change
4. **Optimize**: Make ONE change at a time
5. **Measure**: Run load test again
6. **Compare**: Did performance improve?
7. **Repeat**: Continue until goals met

## Troubleshooting

### Test Won't Start

**Problem**: k6 command not found
```bash
# Solution: Install k6
brew install k6  # macOS
```

**Problem**: Connection refused
```bash
# Solution: Ensure services are running
docker-compose ps
docker-compose up -d
curl http://localhost:3000/health
```

### High Error Rate

**Problem**: http_req_failed > 5%

**Possible Causes**:
1. Rate limiting triggered
2. Database connection exhausted
3. Redis out of memory
4. API server crashed

**Investigation**:
```bash
# Check API logs
docker-compose logs api | tail -100

# Check worker logs
docker-compose logs worker | tail -100

# Check database connections
docker-compose exec postgres psql -U taskflow -c "SELECT count(*) FROM pg_stat_activity;"

# Check Redis memory
docker-compose exec redis redis-cli INFO memory
```

### High Latency

**Problem**: P95 > 1000ms

**Possible Causes**:
1. Database slow queries
2. Redis network latency
3. Worker backlog
4. CPU exhaustion

**Investigation**:
```bash
# Check slow queries
docker-compose logs postgres | grep "duration"

# Check Redis latency
docker-compose exec redis redis-cli --latency

# Check CPU usage
docker stats

# Check queue depth
curl http://localhost:3000/api/queues/default/stats
```

### Queue Backup

**Problem**: Queue depth > 1000

**Possible Causes**:
1. Too few workers
2. Slow job processing
3. Worker crashes
4. Database bottleneck

**Investigation**:
```bash
# Check worker count
curl http://localhost:3000/api/workers | jq '.workers | length'

# Check worker status
curl http://localhost:3000/api/workers | jq .

# Scale workers
docker-compose up -d --scale worker=10

# Check job duration
curl http://localhost:3000/api/metrics | grep job_duration
```

### Memory Leak

**Problem**: Performance degrades over time

**Investigation**:
```bash
# Check memory usage
docker stats

# Profile Node.js heap
node --inspect apps/api/dist/index.js

# Take heap snapshot
# Open chrome://inspect
# Click "Take heap snapshot"
```

## CI/CD Integration

### GitHub Actions Example

```yaml
# .github/workflows/load-test.yml
name: Load Tests

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:      # Manual trigger

jobs:
  load-test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring \
            --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
            --keyserver hkp://keyserver.ubuntu.com:80 \
            --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
            | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update
          sudo apt-get install k6
      
      - name: Start services
        run: |
          docker-compose up -d
          sleep 30  # Wait for services
      
      - name: Health check
        run: |
          curl -f http://localhost:3000/health || exit 1
      
      - name: Run sustained load test
        run: k6 run tests/load/sustained-load.test.js
      
      - name: Run spike load test
        run: k6 run tests/load/spike-load.test.js
      
      - name: Upload results
        uses: actions/upload-artifact@v3
        if: always()
        with:
          name: load-test-results
          path: tests/load/results/
      
      - name: Cleanup
        if: always()
        run: docker-compose down -v
```

### Performance Regression Detection

```yaml
- name: Compare with baseline
  run: |
    # Extract P95 latency from current test
    CURRENT_P95=$(cat tests/load/results/sustained-*.json | jq '.metrics.http_req_duration.values["p(95)"]')
    
    # Load baseline from previous run
    BASELINE_P95=350  # ms
    
    # Fail if regression > 20%
    THRESHOLD=$(echo "$BASELINE_P95 * 1.2" | bc)
    if (( $(echo "$CURRENT_P95 > $THRESHOLD" | bc -l) )); then
      echo "Performance regression detected!"
      echo "Current P95: ${CURRENT_P95}ms"
      echo "Baseline P95: ${BASELINE_P95}ms"
      exit 1
    fi
```

### Slack Notifications

```yaml
- name: Notify Slack
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
    text: 'Load test failed! Check results: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}'
    webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

## Advanced Topics

### Custom Scenarios

Create custom load patterns:

```javascript
export const options = {
  scenarios: {
    custom_pattern: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      stages: [
        { duration: '2m', target: 50 },  // Ramp to 50 rps
        { duration: '5m', target: 50 },  // Hold at 50 rps
        { duration: '2m', target: 100 }, // Spike to 100 rps
        { duration: '5m', target: 10 },  // Drop to 10 rps
      ],
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
};
```

### Distributed Load Testing

Run k6 in distributed mode for higher load:

```bash
# Master node
k6 run --execution-mode master tests/load/sustained-load.test.js

# Worker nodes (multiple machines)
k6 run --execution-mode worker --master-address=192.168.1.100:6565
```

### Integration with APM

Send metrics to Datadog, New Relic, or other APM tools:

```javascript
import { DatadogReporter } from 'k6/x/datadog';

export function handleSummary(data) {
  const reporter = new DatadogReporter();
  reporter.send(data);
  return textSummary(data);
}
```

## References

- [k6 Documentation](https://k6.io/docs/)
- [k6 Test Types](https://k6.io/docs/test-types/introduction/)
- [k6 Metrics Reference](https://k6.io/docs/using-k6/metrics/)
- [k6 Thresholds Guide](https://k6.io/docs/using-k6/thresholds/)
- [k6 Best Practices](https://k6.io/docs/misc/fine-tuning-os/)
- [Grafana k6 Cloud](https://grafana.com/products/cloud/k6/)

## Summary

This load testing suite provides:

✅ **4 comprehensive test scenarios** covering different load patterns  
✅ **Automated metrics collection** with custom metrics  
✅ **Pass/fail thresholds** for automated validation  
✅ **HTML and JSON reports** for analysis  
✅ **Grafana integration** for real-time monitoring  
✅ **CI/CD ready** with GitHub Actions example  
✅ **Production-ready thresholds** based on industry standards  

Use these tests to validate performance, identify bottlenecks, and ensure your system can handle production traffic.
