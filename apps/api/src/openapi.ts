/**
 * OpenAPI Configuration
 *
 * Comprehensive API documentation with Swagger UI
 */

import {
  FastifyInstance,
  type FastifyPluginCallback,
  type FastifySchema,
} from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { submitJobSchema } from '@taskflow/types';

// The plugins' published declarations resolve a distinct Fastify type copy in
// this workspace. This cast is limited to the registration boundary; runtime
// plugin and option values are unchanged.
const swaggerPlugin = fastifySwagger as unknown as FastifyPluginCallback<
  Record<string, unknown>
>;
const swaggerUiPlugin = fastifySwaggerUI as unknown as FastifyPluginCallback<
  Record<string, unknown>
>;

/**
 * Register Swagger documentation
 */
export async function registerSwagger(app: FastifyInstance): Promise<void> {
  // Register Swagger plugin for OpenAPI spec generation
  await app.register(swaggerPlugin, {
    openapi: {
      info: {
        title: 'Resilient TaskFlow API',
        description: `
# Resilient TaskFlow API

Production-grade distributed task queue and asynchronous job-processing platform.

## Features

- **Reliable Job Processing**: At-least-once delivery with automatic retries
- **Priority Queues**: CRITICAL, HIGH, NORMAL, LOW priority levels
- **Scheduled Jobs**: Execute jobs at specific times
- **Idempotency**: Prevent duplicate job submissions
- **Worker Management**: Track worker health and performance
- **Real-time Monitoring**: Queue statistics and worker status

## Authentication

This API supports two authentication methods:

### 1. API Key Authentication
Include your API key in the \`X-API-Key\` header:

\`\`\`
curl -H "X-API-Key: your-api-key" https://api.taskflow.example.com/api/jobs
\`\`\`

### 2. JWT Bearer Token
Include a JWT token in the \`Authorization\` header:

\`\`\`
curl -H "Authorization: Bearer your-jwt-token" https://api.taskflow.example.com/api/jobs
\`\`\`

## Rate Limiting

- **Standard endpoints**: 100 requests per minute
- **Authentication endpoints**: 5 requests per 5 minutes
- Rate limit headers are included in responses:
  - \`X-RateLimit-Limit\`: Maximum requests allowed
  - \`X-RateLimit-Remaining\`: Requests remaining
  - \`X-RateLimit-Reset\`: Timestamp when limit resets

## Error Handling

All errors follow this format:

\`\`\`json
{
  "error": "ErrorType",
  "message": "Human-readable error message",
  "statusCode": 400,
  "timestamp": "2026-08-23T10:00:00.000Z",
  "requestId": "req-123-456"
}
\`\`\`

### Common Error Codes

- \`400 Bad Request\`: Invalid input or validation error
- \`401 Unauthorized\`: Missing or invalid authentication
- \`403 Forbidden\`: Insufficient permissions
- \`404 Not Found\`: Resource doesn't exist
- \`409 Conflict\`: Resource conflict (e.g., duplicate idempotency key)
- \`429 Too Many Requests\`: Rate limit exceeded
- \`500 Internal Server Error\`: Server error
- \`503 Service Unavailable\`: Service temporarily unavailable

## Idempotency

For idempotent requests, include an \`Idempotency-Key\` header:

\`\`\`
curl -X POST \\
  -H "X-API-Key: your-api-key" \\
  -H "Idempotency-Key: unique-request-id-123" \\
  -H "Content-Type: application/json" \\
  -d '{"type": "email-send", "payload": {...}}' \\
  https://api.taskflow.example.com/api/jobs
\`\`\`

Duplicate requests with the same key return the original response (24-hour window).

## Pagination

List endpoints support pagination:

- \`limit\`: Number of results (default: 20, max: 100)
- \`offset\`: Skip N results (default: 0)
- \`cursor\`: Cursor-based pagination (alternative to offset)

Example:
\`\`\`
GET /api/jobs?limit=50&offset=100
\`\`\`

## Webhooks

Configure webhooks to receive job lifecycle events:

- \`job.created\`
- \`job.started\`
- \`job.completed\`
- \`job.failed\`
- \`job.retried\`
- \`job.cancelled\`

## SDKs

Official SDKs available:
- Node.js/TypeScript: \`npm install @taskflow/client\`
- Python: \`pip install taskflow-client\`
- Go: \`go get github.com/taskflow/client-go\`

## Support

- Documentation: https://docs.taskflow.example.com
- GitHub: https://github.com/taskflow/resilient-taskflow
- Email: support@taskflow.example.com
        `.trim(),
        version: '1.0.0',
        contact: {
          name: 'TaskFlow Support',
          email: 'support@taskflow.example.com',
          url: 'https://taskflow.example.com/support',
        },
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT',
        },
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Development server',
        },
        {
          url: 'https://staging-api.taskflow.example.com',
          description: 'Staging server',
        },
        {
          url: 'https://api.taskflow.example.com',
          description: 'Production server',
        },
      ],
      tags: [
        {
          name: 'Jobs',
          description: 'Job submission and management',
        },
        {
          name: 'Queues',
          description: 'Queue statistics and configuration',
        },
        {
          name: 'Workers',
          description: 'Worker health and performance',
        },
        {
          name: 'Health',
          description: 'Service health checks',
        },
        {
          name: 'Metrics',
          description: 'Prometheus metrics',
        },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
            description: 'API key for authentication',
          },
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT bearer token',
          },
        },
        schemas: {
          // Job schemas
          SubmitJobRequest: zodToJsonSchema(
            submitJobSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
            'SubmitJobRequest'
          ),

          JobResponse: {
            type: 'object',
            required: ['id', 'type', 'status', 'priority', 'createdAt'],
            properties: {
              id: {
                type: 'string',
                format: 'uuid',
                description: 'Unique job identifier',
                example: '123e4567-e89b-12d3-a456-426614174000',
              },
              type: {
                type: 'string',
                description: 'Job type (handler name)',
                example: 'email-send',
              },
              payload: {
                type: 'object',
                description: 'Job-specific data',
                example: {
                  to: 'user@example.com',
                  subject: 'Welcome!',
                  body: 'Thank you for signing up.',
                },
              },
              status: {
                type: 'string',
                enum: [
                  'CREATED',
                  'QUEUED',
                  'PROCESSING',
                  'SUCCEEDED',
                  'FAILED',
                  'RETRY_SCHEDULED',
                  'CANCEL_REQUESTED',
                  'CANCELLED',
                  'DEAD_LETTERED',
                ],
                description: 'Current job status',
                example: 'QUEUED',
              },
              priority: {
                type: 'string',
                enum: ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'],
                description: 'Job priority level',
                example: 'NORMAL',
              },
              attempts: {
                type: 'integer',
                description: 'Number of execution attempts',
                example: 0,
              },
              maxAttempts: {
                type: 'integer',
                description: 'Maximum retry attempts',
                example: 3,
              },
              createdAt: {
                type: 'string',
                format: 'date-time',
                description: 'Job creation timestamp',
                example: '2026-08-23T10:00:00.000Z',
              },
              scheduledAt: {
                type: 'string',
                format: 'date-time',
                description: 'Scheduled execution time',
                example: '2026-08-23T11:00:00.000Z',
              },
              startedAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
                description: 'Job start timestamp',
              },
              completedAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
                description: 'Job completion timestamp',
              },
              result: {
                type: 'object',
                nullable: true,
                description: 'Job execution result',
              },
              error: {
                type: 'object',
                nullable: true,
                description: 'Error details if failed',
              },
            },
          },

          // Error response
          ErrorResponse: {
            type: 'object',
            required: ['error', 'message', 'statusCode', 'timestamp'],
            properties: {
              error: {
                type: 'string',
                description: 'Error type',
                example: 'ValidationError',
              },
              message: {
                type: 'string',
                description: 'Human-readable error message',
                example: 'Invalid job type',
              },
              statusCode: {
                type: 'integer',
                description: 'HTTP status code',
                example: 400,
              },
              timestamp: {
                type: 'string',
                format: 'date-time',
                description: 'Error timestamp',
                example: '2026-08-23T10:00:00.000Z',
              },
              requestId: {
                type: 'string',
                description: 'Request ID for debugging',
                example: 'req-123-456',
              },
              details: {
                type: 'array',
                description: 'Detailed validation errors',
                items: {
                  type: 'object',
                  properties: {
                    field: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },

          // Queue statistics
          QueueStats: {
            type: 'object',
            properties: {
              queueId: {
                type: 'string',
                format: 'uuid',
                example: 'queue-123',
              },
              name: {
                type: 'string',
                example: 'default',
              },
              total: {
                type: 'integer',
                description: 'Total jobs in queue',
                example: 150,
              },
              byStatus: {
                type: 'object',
                properties: {
                  queued: { type: 'integer', example: 100 },
                  processing: { type: 'integer', example: 50 },
                  failed: { type: 'integer', example: 0 },
                },
              },
              byPriority: {
                type: 'object',
                properties: {
                  CRITICAL: { type: 'integer', example: 5 },
                  HIGH: { type: 'integer', example: 20 },
                  NORMAL: { type: 'integer', example: 100 },
                  LOW: { type: 'integer', example: 25 },
                },
              },
              oldestJob: {
                type: 'string',
                format: 'date-time',
                description: 'Timestamp of oldest queued job',
              },
            },
          },

          // Worker info
          WorkerInfo: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                format: 'uuid',
              },
              workerName: {
                type: 'string',
                example: 'worker-01',
              },
              hostname: {
                type: 'string',
                example: 'worker-pod-1',
              },
              status: {
                type: 'string',
                enum: ['STARTING', 'ACTIVE', 'STOPPING', 'STOPPED', 'FAILED'],
                example: 'ACTIVE',
              },
              concurrency: {
                type: 'integer',
                description: 'Maximum concurrent jobs',
                example: 10,
              },
              currentJobCount: {
                type: 'integer',
                description: 'Currently processing jobs',
                example: 7,
              },
              totalJobsProcessed: {
                type: 'integer',
                example: 1523,
              },
              totalJobsSucceeded: {
                type: 'integer',
                example: 1498,
              },
              totalJobsFailed: {
                type: 'integer',
                example: 25,
              },
              lastHeartbeatAt: {
                type: 'string',
                format: 'date-time',
              },
              startedAt: {
                type: 'string',
                format: 'date-time',
              },
            },
          },

          // Health check
          HealthResponse: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['healthy', 'degraded', 'unhealthy'],
                example: 'healthy',
              },
              timestamp: {
                type: 'string',
                format: 'date-time',
              },
              services: {
                type: 'object',
                properties: {
                  database: {
                    type: 'string',
                    enum: ['up', 'down'],
                    example: 'up',
                  },
                  redis: {
                    type: 'string',
                    enum: ['up', 'down'],
                    example: 'up',
                  },
                  kafka: {
                    type: 'string',
                    enum: ['up', 'down'],
                    example: 'up',
                  },
                },
              },
              uptime: {
                type: 'number',
                description: 'Uptime in seconds',
                example: 3600,
              },
            },
          },
        },
      },
      security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    },
    transform: ({ schema, url }: { schema: FastifySchema; url: string }) => {
      // Transform function is required but we're using explicit schemas
      return { schema, url };
    },
  });

  // Register Swagger UI
  await app.register(swaggerUiPlugin, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
      tryItOutEnabled: true,
    },
    staticCSP: true,
    transformStaticCSP: (header: string) => header,
  });
}

/**
 * Export OpenAPI spec as JSON
 */
export async function exportOpenAPISpec(app: FastifyInstance): Promise<object> {
  return app.swagger();
}
