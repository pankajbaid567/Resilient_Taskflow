# API Documentation Guide

Complete reference for the Resilient TaskFlow REST API.

## Table of Contents

- [Getting Started](#getting-started)
- [Authentication](#authentication)
- [Job Management](#job-management)
- [Queue Operations](#queue-operations)
- [Worker Management](#worker-management)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Best Practices](#best-practices)
- [Code Examples](#code-examples)

## Getting Started

### Base URL

```
Development:  http://localhost:3000
Staging:      https://staging-api.taskflow.example.com
Production:   https://api.taskflow.example.com
```

### Interactive Documentation

Swagger UI is available at `/docs`:

```
http://localhost:3000/docs
```

The Swagger UI provides:
- **Interactive testing**: Try API calls directly from browser
- **Request/response examples**: See actual payloads
- **Schema validation**: Understand required fields
- **Authentication testing**: Test with your API keys

### OpenAPI Specification

Download the OpenAPI 3.0 spec:

```bash
curl http://localhost:3000/docs/json > openapi.json
```

Use with tools like:
- **Postman**: Import OpenAPI spec for collection
- **Insomnia**: Import for API testing
- **Code generators**: Generate client SDKs

## Authentication

### API Key Authentication

**Recommended for server-to-server communication.**

Include your API key in the `X-API-Key` header:

```bash
curl -H "X-API-Key: your-api-key-here" \
  https://api.taskflow.example.com/api/v1/jobs
```

**Example with different languages**:

```javascript
// JavaScript (fetch)
fetch('https://api.taskflow.example.com/api/v1/jobs', {
  headers: {
    'X-API-Key': 'your-api-key-here',
    'Content-Type': 'application/json',
  },
});
```

```python
# Python (requests)
import requests

headers = {
    'X-API-Key': 'your-api-key-here',
    'Content-Type': 'application/json',
}

response = requests.get(
    'https://api.taskflow.example.com/api/v1/jobs',
    headers=headers
)
```

```go
// Go
client := &http.Client{}
req, _ := http.NewRequest("GET", "https://api.taskflow.example.com/api/v1/jobs", nil)
req.Header.Add("X-API-Key", "your-api-key-here")
req.Header.Add("Content-Type", "application/json")

resp, err := client.Do(req)
```

### JWT Bearer Token Authentication

**Recommended for user-facing applications.**

Include JWT token in `Authorization` header:

```bash
curl -H "Authorization: Bearer your-jwt-token" \
  https://api.taskflow.example.com/api/v1/jobs
```

**Example**:

```javascript
// JavaScript
const token = 'your-jwt-token';

fetch('https://api.taskflow.example.com/api/v1/jobs', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
});
```

### API Key Management

**Generate a new API key**:

```bash
# Not yet implemented - placeholder for future endpoint
POST /api/v1/auth/api-keys

{
  "name": "Production API Key",
  "expiresAt": "2027-12-31T23:59:59Z"
}
```

**Security Best Practices**:
- ✅ Store API keys securely (environment variables, secrets manager)
- ✅ Use different keys for each environment (dev, staging, prod)
- ✅ Rotate keys every 90 days
- ✅ Revoke unused or compromised keys immediately
- ❌ Never commit keys to version control
- ❌ Never expose keys in client-side code

## Job Management

### Submit a Job

Create a new job for asynchronous processing.

**Endpoint**: `POST /api/v1/jobs`

**Request Body**:

```json
{
  "type": "email-send",
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome!",
    "body": "Thank you for signing up."
  },
  "priority": "NORMAL",
  "queue": "default",
  "maxAttempts": 3,
  "timeoutMs": 30000,
  "scheduledAt": "2026-08-24T10:00:00Z",
  "metadata": {
    "userId": "user-123",
    "source": "signup-flow"
  },
  "tags": ["email", "user-notification"]
}
```

**Field Descriptions**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✅ | Job handler name (e.g., `email-send`) |
| `payload` | object | ✅ | Job-specific data |
| `priority` | enum | ❌ | `CRITICAL`, `HIGH`, `NORMAL` (default), `LOW` |
| `queue` | string | ❌ | Queue name (default: `default`) |
| `maxAttempts` | integer | ❌ | Retry limit (default: 3, max: 10) |
| `timeoutMs` | integer | ❌ | Execution timeout (default: 30000, max: 300000) |
| `scheduledAt` | datetime | ❌ | Schedule for future execution |
| `metadata` | object | ❌ | Additional metadata |
| `tags` | array | ❌ | Tags for filtering (max: 10) |

**Response** (201 Created):

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "type": "email-send",
  "status": "QUEUED",
  "priority": "NORMAL",
  "attempts": 0,
  "maxAttempts": 3,
  "createdAt": "2026-08-23T10:00:00.000Z",
  "scheduledAt": "2026-08-24T10:00:00Z"
}
```

**Example**:

```bash
curl -X POST \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "email-send",
    "payload": {
      "to": "user@example.com",
      "subject": "Welcome!"
    }
  }' \
  https://api.taskflow.example.com/api/v1/jobs
```

```javascript
// JavaScript/TypeScript
const response = await fetch('https://api.taskflow.example.com/api/v1/jobs', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your-api-key',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    type: 'email-send',
    payload: {
      to: 'user@example.com',
      subject: 'Welcome!',
      body: 'Thank you for signing up.',
    },
    priority: 'NORMAL',
  }),
});

const job = await response.json();
console.log('Job created:', job.id);
```

```python
# Python
response = requests.post(
    'https://api.taskflow.example.com/api/v1/jobs',
    headers={
        'X-API-Key': 'your-api-key',
        'Content-Type': 'application/json',
    },
    json={
        'type': 'email-send',
        'payload': {
            'to': 'user@example.com',
            'subject': 'Welcome!',
        },
        'priority': 'NORMAL',
    }
)

job = response.json()
print(f"Job created: {job['id']}")
```

### Idempotent Job Submission

Prevent duplicate job submissions using idempotency keys.

**Headers**:
```
X-API-Key: your-api-key
Idempotency-Key: unique-request-id-123
Content-Type: application/json
```

**Behavior**:
- First request with key: Creates job, returns 201
- Duplicate request (within 24h): Returns original job, 200
- After 24h: Key expires, new job can be created

**Example**:

```bash
curl -X POST \
  -H "X-API-Key: your-api-key" \
  -H "Idempotency-Key: order-456-email" \
  -H "Content-Type: application/json" \
  -d '{"type": "order-confirmation", "payload": {...}}' \
  https://api.taskflow.example.com/api/v1/jobs
```

**Use Cases**:
- Retrying failed requests safely
- Preventing double-charging in payment flows
- Avoiding duplicate notifications

### Get Job Status

Retrieve current job status and details.

**Endpoint**: `GET /api/v1/jobs/:jobId`

**Response** (200 OK):

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "type": "email-send",
  "status": "SUCCEEDED",
  "priority": "NORMAL",
  "attempts": 1,
  "maxAttempts": 3,
  "createdAt": "2026-08-23T10:00:00.000Z",
  "startedAt": "2026-08-23T10:00:05.000Z",
  "completedAt": "2026-08-23T10:00:08.000Z",
  "result": {
    "messageId": "msg-789",
    "status": "sent"
  }
}
```

**Job Statuses**:

| Status | Description |
|--------|-------------|
| `CREATED` | Job created, not yet queued |
| `QUEUED` | Waiting for worker pickup |
| `PROCESSING` | Currently being processed |
| `SUCCEEDED` | Completed successfully |
| `FAILED` | Failed after all retries |
| `RETRY_SCHEDULED` | Scheduled for retry |
| `CANCEL_REQUESTED` | Cancellation requested |
| `CANCELLED` | Successfully cancelled |
| `DEAD_LETTERED` | Moved to dead letter queue |

**Example**:

```javascript
// Poll for job completion
async function waitForJob(jobId) {
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes
  
  while (attempts < maxAttempts) {
    const response = await fetch(
      `https://api.taskflow.example.com/api/v1/jobs/${jobId}`,
      {
        headers: { 'X-API-Key': 'your-api-key' },
      }
    );
    
    const job = await response.json();
    
    if (job.status === 'SUCCEEDED') {
      return job.result;
    }
    
    if (job.status === 'FAILED' || job.status === 'CANCELLED') {
      throw new Error(`Job ${job.status}: ${job.error?.message}`);
    }
    
    // Wait 5 seconds before next poll
    await new Promise(resolve => setTimeout(resolve, 5000));
    attempts++;
  }
  
  throw new Error('Job timeout');
}
```

### List Jobs

Get list of jobs with filtering and pagination.

**Endpoint**: `GET /api/v1/jobs`

**Query Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | enum | Filter by status |
| `priority` | enum | Filter by priority |
| `type` | string | Filter by job type |
| `queue` | string | Filter by queue name |
| `tags` | string | Filter by tags (comma-separated) |
| `limit` | integer | Results per page (default: 20, max: 100) |
| `offset` | integer | Skip N results (default: 0) |
| `sortBy` | enum | Sort by field (`createdAt`, `scheduledAt`) |
| `sortOrder` | enum | Sort order (`asc`, `desc`) |

**Example**:

```bash
# Get failed jobs
curl -H "X-API-Key: your-api-key" \
  "https://api.taskflow.example.com/api/v1/jobs?status=FAILED&limit=50"

# Get high-priority jobs
curl -H "X-API-Key: your-api-key" \
  "https://api.taskflow.example.com/api/v1/jobs?priority=HIGH&sortBy=createdAt&sortOrder=desc"
```

**Response**:

```json
{
  "jobs": [
    {
      "id": "...",
      "type": "...",
      "status": "...",
      "..."
    }
  ],
  "pagination": {
    "total": 1250,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

### Cancel a Job

Cancel a pending or running job.

**Endpoint**: `POST /api/v1/jobs/:jobId/cancel`

**Behavior**:
- **Queued jobs**: Immediately cancelled
- **Processing jobs**: Cancellation requested, job must check cancellation token
- **Completed jobs**: Cannot be cancelled (returns 400)

**Response** (200 OK):

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "status": "CANCEL_REQUESTED",
  "message": "Cancellation requested. Job will stop soon."
}
```

**Example**:

```bash
curl -X POST \
  -H "X-API-Key: your-api-key" \
  https://api.taskflow.example.com/api/v1/jobs/123e4567-e89b-12d3-a456-426614174000/cancel
```

## Queue Operations

### Get Queue Statistics

Retrieve statistics for a queue.

**Endpoint**: `GET /api/v1/queues/:queueName/stats`

**Response**:

```json
{
  "queueId": "queue-123",
  "name": "default",
  "total": 150,
  "byStatus": {
    "queued": 100,
    "processing": 45,
    "failed": 5
  },
  "byPriority": {
    "CRITICAL": 5,
    "HIGH": 20,
    "NORMAL": 100,
    "LOW": 25
  },
  "oldestJob": "2026-08-23T09:00:00.000Z",
  "avgProcessingTime": 3.5,
  "throughput": {
    "lastMinute": 50,
    "lastHour": 2500,
    "lastDay": 45000
  }
}
```

**Example**:

```bash
curl -H "X-API-Key: your-api-key" \
  https://api.taskflow.example.com/api/v1/queues/default/stats
```

### List All Queues

Get list of all queues with basic stats.

**Endpoint**: `GET /api/v1/queues`

**Response**:

```json
{
  "queues": [
    {
      "name": "default",
      "total": 150,
      "processing": 45
    },
    {
      "name": "emails",
      "total": 50,
      "processing": 10
    }
  ]
}
```

## Worker Management

### List Workers

Get list of active workers.

**Endpoint**: `GET /api/v1/workers`

**Response**:

```json
{
  "workers": [
    {
      "id": "worker-123",
      "workerName": "worker-01",
      "hostname": "worker-pod-1",
      "status": "ACTIVE",
      "concurrency": 10,
      "currentJobCount": 7,
      "totalJobsProcessed": 1523,
      "totalJobsSucceeded": 1498,
      "totalJobsFailed": 25,
      "lastHeartbeatAt": "2026-08-23T10:00:00.000Z",
      "startedAt": "2026-08-23T08:00:00.000Z"
    }
  ],
  "summary": {
    "total": 10,
    "active": 9,
    "inactive": 1,
    "totalCapacity": 100,
    "currentLoad": 67
  }
}
```

### Get Worker Details

**Endpoint**: `GET /api/v1/workers/:workerId`

**Response**: Single worker object with detailed metrics.

## Error Handling

All errors follow a consistent format:

```json
{
  "error": "ErrorType",
  "message": "Human-readable error message",
  "statusCode": 400,
  "timestamp": "2026-08-23T10:00:00.000Z",
  "requestId": "req-123-456",
  "details": [
    {
      "field": "type",
      "message": "Job type is required"
    }
  ]
}
```

### HTTP Status Codes

| Code | Description | When It Occurs |
|------|-------------|----------------|
| `200` | OK | Successful request |
| `201` | Created | Resource created successfully |
| `400` | Bad Request | Invalid input or validation error |
| `401` | Unauthorized | Missing or invalid authentication |
| `403` | Forbidden | Insufficient permissions |
| `404` | Not Found | Resource doesn't exist |
| `409` | Conflict | Resource conflict (duplicate idempotency key with different data) |
| `422` | Unprocessable Entity | Valid syntax but semantic error |
| `429` | Too Many Requests | Rate limit exceeded |
| `500` | Internal Server Error | Server error (should not happen) |
| `503` | Service Unavailable | Service temporarily unavailable |

### Error Types

| Error Type | Description |
|------------|-------------|
| `ValidationError` | Input validation failed |
| `AuthenticationError` | Authentication failed |
| `AuthorizationError` | Insufficient permissions |
| `NotFoundError` | Resource not found |
| `ConflictError` | Resource conflict |
| `RateLimitError` | Rate limit exceeded |
| `InternalError` | Internal server error |

### Error Handling Examples

```javascript
// JavaScript
try {
  const response = await fetch('https://api.taskflow.example.com/api/v1/jobs', {
    method: 'POST',
    headers: {
      'X-API-Key': 'your-api-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(jobData),
  });
  
  if (!response.ok) {
    const error = await response.json();
    
    switch (response.status) {
      case 400:
        console.error('Validation error:', error.details);
        break;
      case 401:
        console.error('Authentication failed');
        // Refresh token or re-authenticate
        break;
      case 429:
        const retryAfter = response.headers.get('Retry-After');
        console.error(`Rate limited. Retry after ${retryAfter}s`);
        // Wait and retry
        break;
      default:
        console.error('API error:', error.message);
    }
    
    throw new Error(error.message);
  }
  
  const job = await response.json();
  return job;
} catch (error) {
  console.error('Request failed:', error);
  throw error;
}
```

```python
# Python
try:
    response = requests.post(
        'https://api.taskflow.example.com/api/v1/jobs',
        headers={'X-API-Key': 'your-api-key'},
        json=job_data
    )
    response.raise_for_status()
    job = response.json()
except requests.exceptions.HTTPError as e:
    error = e.response.json()
    
    if e.response.status_code == 400:
        print(f"Validation error: {error['details']}")
    elif e.response.status_code == 429:
        retry_after = e.response.headers.get('Retry-After')
        print(f"Rate limited. Retry after {retry_after}s")
    else:
        print(f"API error: {error['message']}")
    
    raise
```

## Rate Limiting

### Limits

| Endpoint Type | Limit | Window |
|---------------|-------|--------|
| Standard API | 100 requests | 1 minute |
| Job submission | 50 requests | 1 minute |
| Authentication | 5 requests | 5 minutes |
| Health checks | 1000 requests | 1 minute |

### Rate Limit Headers

Every response includes rate limit information:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1692792000
```

### Handling Rate Limits

```javascript
async function makeRequestWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
      console.log(`Rate limited. Waiting ${retryAfter}s...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    
    return response;
  }
  
  throw new Error('Max retries exceeded');
}
```

## Best Practices

### 1. Use Idempotency Keys

Always use idempotency keys for critical operations:

```javascript
const idempotencyKey = `order-${orderId}-confirmation`;

await fetch('https://api.taskflow.example.com/api/v1/jobs', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
    'Idempotency-Key': idempotencyKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(jobData),
});
```

### 2. Implement Exponential Backoff

For retries, use exponential backoff:

```javascript
async function submitJobWithRetry(jobData, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await submitJob(jobData);
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

### 3. Poll Efficiently

Don't poll too frequently:

```javascript
// ❌ Bad: Poll every second
setInterval(checkJobStatus, 1000);

// ✅ Good: Poll with increasing intervals
async function pollJobStatus(jobId) {
  const intervals = [2000, 5000, 10000, 30000]; // 2s, 5s, 10s, 30s
  let intervalIndex = 0;
  
  while (true) {
    const job = await getJobStatus(jobId);
    
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
      return job;
    }
    
    const delay = intervals[Math.min(intervalIndex, intervals.length - 1)];
    await new Promise(resolve => setTimeout(resolve, delay));
    intervalIndex++;
  }
}
```

### 4. Use Webhooks Instead of Polling

Configure webhooks for job completion (when available):

```javascript
// Webhook payload
{
  "event": "job.completed",
  "timestamp": "2026-08-23T10:00:00.000Z",
  "data": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "status": "SUCCEEDED",
    "result": {...}
  }
}
```

### 5. Handle Timeouts

Set appropriate timeouts:

```javascript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

try {
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {...},
  });
  
  clearTimeout(timeoutId);
  return await response.json();
} catch (error) {
  if (error.name === 'AbortError') {
    console.error('Request timeout');
  }
  throw error;
}
```

### 6. Batch Operations

Submit multiple jobs in parallel:

```javascript
// ✅ Good: Parallel submission
const jobPromises = jobsData.map(data =>
  submitJob(data)
);

const jobs = await Promise.all(jobPromises);
```

### 7. Monitor Rate Limits

Track rate limit usage:

```javascript
function trackRateLimit(response) {
  const limit = response.headers.get('X-RateLimit-Limit');
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const reset = response.headers.get('X-RateLimit-Reset');
  
  const percentageUsed = ((limit - remaining) / limit) * 100;
  
  if (percentageUsed > 80) {
    console.warn(`Rate limit at ${percentageUsed.toFixed(0)}%`);
  }
}
```

## Code Examples

### Complete Job Submission Flow

```typescript
// TypeScript
import axios, { AxiosInstance } from 'axios';

class TaskFlowClient {
  private client: AxiosInstance;

  constructor(apiKey: string, baseURL = 'https://api.taskflow.example.com') {
    this.client = axios.create({
      baseURL,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Add retry interceptor
    this.client.interceptors.response.use(
      response => response,
      async error => {
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 60;
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return this.client.request(error.config);
        }
        throw error;
      }
    );
  }

  async submitJob(jobData: {
    type: string;
    payload: any;
    priority?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
    idempotencyKey?: string;
  }) {
    const headers: any = {};
    if (jobData.idempotencyKey) {
      headers['Idempotency-Key'] = jobData.idempotencyKey;
    }

    const response = await this.client.post('/api/v1/jobs', jobData, { headers });
    return response.data;
  }

  async getJob(jobId: string) {
    const response = await this.client.get(`/api/v1/jobs/${jobId}`);
    return response.data;
  }

  async waitForCompletion(jobId: string, timeoutMs = 300000) {
    const startTime = Date.now();
    const intervals = [2000, 5000, 10000, 30000];
    let intervalIndex = 0;

    while (Date.now() - startTime < timeoutMs) {
      const job = await this.getJob(jobId);

      if (job.status === 'SUCCEEDED') {
        return job;
      }

      if (job.status === 'FAILED' || job.status === 'CANCELLED') {
        throw new Error(`Job ${job.status}: ${job.error?.message}`);
      }

      const delay = intervals[Math.min(intervalIndex, intervals.length - 1)];
      await new Promise(resolve => setTimeout(resolve, delay));
      intervalIndex++;
    }

    throw new Error('Job timeout');
  }

  async cancelJob(jobId: string) {
    const response = await this.client.post(`/api/v1/jobs/${jobId}/cancel`);
    return response.data;
  }
}

// Usage
const client = new TaskFlowClient('your-api-key');

// Submit and wait for job
const job = await client.submitJob({
  type: 'email-send',
  payload: {
    to: 'user@example.com',
    subject: 'Welcome!',
  },
  priority: 'NORMAL',
  idempotencyKey: `signup-${userId}`,
});

console.log('Job submitted:', job.id);

// Wait for completion
const completedJob = await client.waitForCompletion(job.id);
console.log('Job completed:', completedJob.result);
```

## Summary

### Key Takeaways

✅ **Use Swagger UI** for interactive testing and exploration  
✅ **Implement idempotency** for critical operations  
✅ **Handle rate limits** with exponential backoff  
✅ **Poll efficiently** with increasing intervals  
✅ **Monitor errors** and implement proper error handling  
✅ **Secure API keys** in environment variables  
✅ **Set timeouts** for all requests  
✅ **Use batch operations** when possible  

### Quick Links

- **Interactive Docs**: http://localhost:3000/docs
- **OpenAPI Spec**: http://localhost:3000/docs/json
- **Health Check**: http://localhost:3000/health
- **Metrics**: http://localhost:3000/metrics

### Support

For questions or issues:
- 📧 Email: support@taskflow.example.com
- 📚 Documentation: https://docs.taskflow.example.com
- 🐛 GitHub Issues: https://github.com/taskflow/resilient-taskflow/issues

---

**Next**: Explore the [Swagger UI](http://localhost:3000/docs) to try the API interactively!
