# Load Testing with k6

This directory contains k6 load tests for Resilient TaskFlow.

## Installation

### macOS
```bash
brew install k6
```

### Linux
```bash
# Debian/Ubuntu
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

# Fedora/CentOS
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

## Quick Start

```bash
# Start the system
docker-compose up -d

# Wait for services to be ready
sleep 10

# Run sustained load test
pnpm load:sustained

# Run spike load test
pnpm load:spike

# Run worker scaling test
pnpm load:scaling

# Run mixed workload test
pnpm load:mixed

# Run all load tests
pnpm load:all
```

## Test Scenarios

### 1. Sustained Load (`sustained-load.test.js`)
- **Duration**: 5 minutes
- **VUs**: 10 → 50 → 10 (ramp up, sustain, ramp down)
- **Purpose**: Measure steady-state performance
- **Metrics**: Throughput, latency, success rate

### 2. Spike Load (`spike-load.test.js`)
- **Duration**: 3 minutes
- **VUs**: 10 → 100 (sudden spike) → 10
- **Purpose**: Test recovery from traffic spikes
- **Metrics**: Error rate during spike, recovery time

### 3. Worker Scaling (`worker-scaling.test.js`)
- **Duration**: 10 minutes
- **Workers**: 1 → 5 → 10 → 5 → 1 (dynamic scaling)
- **Purpose**: Validate system scales with worker count
- **Metrics**: Jobs/sec vs worker count, queue depth

### 4. Mixed Workload (`mixed-workload.test.js`)
- **Duration**: 5 minutes
- **Mix**: Different priorities, job types, durations
- **Purpose**: Simulate realistic production traffic
- **Metrics**: Priority-based latency, distribution

## Metrics

k6 tracks these metrics automatically:
- **http_req_duration**: HTTP request latency (P95, P99)
- **http_req_failed**: Failed request rate
- **http_reqs**: Total requests per second
- **vus**: Virtual users (concurrent connections)

Custom metrics:
- **job_submission_duration**: Time to submit job
- **job_completion_duration**: End-to-end job duration
- **queue_depth**: Current queue backlog
- **jobs_per_second**: Job throughput

## Thresholds

Tests fail if:
- P95 latency > 500ms
- P99 latency > 1000ms
- Error rate > 1%
- Job submission time > 200ms

## Interpreting Results

### Good Performance
```
http_req_duration..........: avg=120ms  p95=250ms  p99=400ms
http_req_failed............: 0.05% ✓
http_reqs..................: 500/s
```

### Degraded Performance
```
http_req_duration..........: avg=450ms  p95=800ms  p99=1200ms  ✗
http_req_failed............: 2.5% ✗
http_reqs..................: 150/s
```

## Best Practices

1. **Start small**: Begin with low VUs, increase gradually
2. **Monitor system**: Watch Grafana during tests
3. **Baseline first**: Run without load to establish baseline
4. **Isolate tests**: Run one scenario at a time
5. **Clean between runs**: Clear queue between tests
6. **Warm up**: Allow 30s warmup before measuring

## Troubleshooting

### High Error Rate
- Check API logs: `docker-compose logs api`
- Check database connections
- Verify rate limits not exceeded

### High Latency
- Check queue depth (backlog?)
- Check worker count (under-provisioned?)
- Check database slow queries

### Connection Errors
- Ensure services running: `docker-compose ps`
- Check API health: `curl http://localhost:3000/health`
- Verify network connectivity

## Advanced Usage

### Custom Scenario
```javascript
export const options = {
  scenarios: {
    custom: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 20 },
        { duration: '1m', target: 0 },
      ],
    },
  },
};
```

### Environment Variables
```bash
# Custom API URL
K6_API_URL=http://production.example.com:3000 k6 run sustained-load.test.js

# Custom duration
K6_DURATION=10m k6 run sustained-load.test.js

# Custom VUs
K6_VUS=100 k6 run sustained-load.test.js
```

### Docker Usage
```bash
docker run --rm -i \
  --network host \
  -v $PWD:/tests \
  grafana/k6:latest \
  run /tests/sustained-load.test.js
```

## Integration with CI/CD

```yaml
# .github/workflows/load-test.yml
name: Load Tests
on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM

jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update
          sudo apt-get install k6
      - name: Start services
        run: docker-compose up -d
      - name: Run load tests
        run: pnpm load:all
      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: load-test-results
          path: tests/load/results/
```

## References

- [k6 Documentation](https://k6.io/docs/)
- [k6 Test Types](https://k6.io/docs/test-types/introduction/)
- [k6 Metrics](https://k6.io/docs/using-k6/metrics/)
- [k6 Thresholds](https://k6.io/docs/using-k6/thresholds/)
