# TaskFlow API

REST API server for TaskFlow distributed task queue system.

## Features

- **Fastify Framework**: High-performance HTTP server
- **Job Management**: Submit, query, cancel, and retry jobs
- **Queue Statistics**: Monitor queue depth and performance
- **Worker Management**: Track active workers and their health
- **Authentication**: API key and JWT support
- **Rate Limiting**: Redis-based distributed rate limiting
- **Metrics**: Prometheus-compatible metrics endpoint
- **Health Checks**: Kubernetes-compatible readiness/liveness probes

## Architecture

### Routes

```
/health
  GET  /          - Basic health check
  GET  /ready     - Readiness probe (checks dependencies)
  GET  /live      - Liveness probe

/metrics
  GET  /          - Prometheus metrics

/api/v1/jobs
  POST /          - Submit new job
  GET  /          - List user's jobs (paginated)
  GET  /:id       - Get job by ID
  DELETE /:id     - Cancel job
  POST /:id/retry - Retry failed job

/api/v1/queues
  GET  /               - List all queues
  GET  /:name/stats    - Get queue statistics
  POST /:name/pause    - Pause queue
  POST /:name/resume   - Resume queue

/api/v1/workers
  GET  /           - List all workers
  GET  /:id        - Get worker by ID
  GET  /:id/stats  - Get worker statistics
  POST /:id/stop   - Stop worker gracefully
```

### Middleware

- **Request Logger**: Structured logging with requestId
- **Error Handler**: Consistent error responses with Zod validation support
- **Authentication**: API key or JWT validation
- **Rate Limiter**: Sliding window rate limiting with Redis
  - Job submission: 50 req/min
  - Read operations: 200 req/min
  - Health checks: 1000 req/min

### Authentication

Two methods supported:

1. **API Key**: `X-API-Key: your-api-key`
2. **JWT**: `Authorization: Bearer your-jwt-token`

There are no implicit development credentials. API keys must have a salted HMAC
digest in `api_keys`, must be unexpired and unrevoked, and must belong to an
active user. JWT subjects must be UUIDs; current user activity and role are
resolved from PostgreSQL.

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL running
- Redis running

### Install Dependencies

```bash
pnpm install
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# API Server
API_HOST=0.0.0.0
API_PORT=3000

# Database
DATABASE_URL=postgresql://taskflow:password@localhost:5432/taskflow

# Redis
REDIS_URL=redis://localhost:6379
```

### Run Migrations

```bash
pnpm --filter @taskflow/database run db:migrate
```

### Development

```bash
# Start API server in watch mode
pnpm dev

# From workspace root
pnpm --filter @taskflow/api dev
```

Server will start on `http://localhost:3000`

### Production Build

```bash
# Build
pnpm build

# Start
pnpm start
```

## API Usage Examples

### Submit Job

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "type": "send-email",
    "payload": {
      "to": "user@example.com",
      "subject": "Hello",
      "body": "Test email"
    },
    "queue": "email",
    "priority": "HIGH"
  }'
```

### Get Job Status

```bash
curl http://localhost:3000/api/v1/jobs/{jobId} \
  -H "X-API-Key: $API_KEY"
```

### List Jobs

```bash
curl "http://localhost:3000/api/v1/jobs?status=QUEUED&limit=20" \
  -H "X-API-Key: $API_KEY"
```

### Cancel Job

```bash
curl -X DELETE http://localhost:3000/api/v1/jobs/{jobId} \
  -H "X-API-Key: $API_KEY"
```

### Queue Statistics

```bash
curl http://localhost:3000/api/v1/queues/default/stats \
  -H "X-API-Key: $API_KEY"
```

### Health Checks

```bash
# Basic health
curl http://localhost:3000/health

# Readiness (checks DB & Redis)
curl http://localhost:3000/health/ready

# Liveness
curl http://localhost:3000/health/live
```

### Metrics

```bash
curl http://localhost:3000/metrics
```

## Response Format

### Success Response

```json
{
  "id": "job_123",
  "status": "QUEUED",
  "type": "send-email",
  "queue": "email",
  "priority": "HIGH",
  "attempts": 0,
  "maxAttempts": 3,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "scheduledAt": "2024-01-01T00:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "result": null,
  "error": null
}
```

### Error Response

```json
{
  "error": "Validation Error",
  "message": "Request validation failed",
  "statusCode": 400,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "path": "/api/v1/jobs",
  "details": [
    {
      "code": "invalid_type",
      "expected": "string",
      "received": "undefined",
      "path": ["type"],
      "message": "Required"
    }
  ]
}
```

## Rate Limiting

Rate limit headers are included in responses:

```
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 49
X-RateLimit-Reset: 1704067260000
Retry-After: 60
```

When rate limit is exceeded, you'll receive:

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 45 seconds.",
  "statusCode": 429,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "retryAfter": 45
}
```

## Testing

```bash
# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Type checking
pnpm typecheck

# Linting
pnpm lint
```

## Docker

```bash
# Build image
docker build -t taskflow-api .

# Run container
docker run -p 3000:3000 \
  -e DATABASE_URL=postgresql://... \
  -e REDIS_URL=redis://... \
  taskflow-api
```

## Monitoring

### Prometheus Metrics

The `/metrics` endpoint exposes metrics in Prometheus format:

- `taskflow_jobs_total{status}` - Job counts by status
- `process_uptime_seconds` - Process uptime
- `process_memory_bytes{type}` - Memory usage

Configure Prometheus to scrape:

```yaml
scrape_configs:
  - job_name: 'taskflow-api'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
```

### Health Checks

Kubernetes readiness/liveness probe configuration:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

## Security

### Production Checklist

- [ ] Change `JWT_SECRET` to a strong random value (min 32 chars)
- [ ] Change `API_KEY_HASH_SALT` to a strong random value
- [ ] Set `NODE_ENV=production`
- [ ] Configure CORS allowlist (don't use `origin: true`)
- [ ] Enable HTTPS/TLS
- [ ] Set appropriate rate limits
- [ ] Review and update CSP headers
- [ ] Enable audit logging
- [ ] Rotate API keys regularly
- [ ] Use secrets management (AWS Secrets Manager, HashiCorp Vault)

### Authentication Best Practices

- Store only the salted HMAC digest of each API key
- Use short-lived JWTs (15min - 1hour)
- Implement refresh tokens
- Log all authentication failures
- Implement account lockout after N failed attempts

## TODO

Phase 4 completions needed:

- [ ] Implement job retry endpoint
- [ ] Implement queue pause/resume
- [ ] Implement worker stop endpoint
- [ ] Add request body size limits
- [ ] Add CORS configuration per environment
- [ ] Add circuit breaker for database/Redis failures

## License

MIT
