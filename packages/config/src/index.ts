import path from 'path';

import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

const environmentBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}, z.boolean());

// Load environment variables from workspace root
dotenvConfig({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Environment Configuration Schema
 *
 * All environment variables are validated at startup.
 * Missing required variables will cause the application to fail fast.
 */
const envSchema = z.object({
  // Application
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // API Server
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_TRUSTED_PROXIES: z.string().default(''),
  API_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(2).default(10000),

  // PostgreSQL
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDIS_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  REDIS_RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_QUEUES: z.string().default('default'),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10000),
  WORKER_LEASE_DURATION_MS: z.coerce.number().int().positive().default(30000),

  // Job Configuration
  JOB_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  JOB_DEFAULT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JOB_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),
  JOB_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(60000),

  // Rate Limiting
  // Requests allowed per user per minute (per IP for /metrics). Each class has
  // its own budget; defaults match the documented limits.
  RATE_LIMIT_JOB_SUBMISSION_PER_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(50),
  RATE_LIMIT_MUTATION_PER_MIN: z.coerce.number().int().positive().default(50),
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_METRICS_PER_MIN: z.coerce.number().int().positive().default(1000),

  // Security
  JWT_SECRET: z.string().min(32),
  API_KEY_HASH_SALT: z.string().min(16),

  // Observability
  ENABLE_METRICS: environmentBoolean.default(true),
  METRICS_PORT: z.coerce.number().int().positive().default(9090),
  // Worker /metrics endpoint. Unauthenticated, so it listens on loopback by
  // default; bind 0.0.0.0 only on a private network (for example a Docker
  // network that is not published). 0 disables it.
  WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  WORKER_METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  ENABLE_TRACING: environmentBoolean.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .url()
    .default('http://localhost:4318'),

  // Retention & Lifecycle Cleanup
  RETENTION_JOBS_DAYS: z.coerce.number().int().positive().default(30),
  RETENTION_EVENTS_DAYS: z.coerce.number().int().positive().default(14),
  RETENTION_ATTEMPTS_DAYS: z.coerce.number().int().positive().default(14),
  RETENTION_DEAD_LETTERS_DAYS: z.coerce.number().int().positive().default(30),
  RETENTION_DELIVERIES_DAYS: z.coerce.number().int().positive().default(7),
  RETENTION_WORKERS_DAYS: z.coerce.number().int().positive().default(7),
  RETENTION_IDEMPOTENCY_KEYS_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .default(24),
  RETENTION_AUDIT_LOGS_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_REDIS_STREAM_MAX_LEN: z.coerce
    .number()
    .int()
    .positive()
    .default(100000),
  RETENTION_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  // Dispatch: how many entries the dispatcher keeps in flight in each queue's
  // Redis stream. The rest of the backlog stays in PostgreSQL, where it is
  // ordered by priority. 0 disables the window (publish everything at once).
  DISPATCH_MAX_IN_FLIGHT_PER_QUEUE: z.coerce.number().int().min(0).default(200),
  RETENTION_ENABLED: environmentBoolean.default(true),
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(1000).default(3_600_000),
});

/**
 * Validated Environment Configuration
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables
 */
function parseEnv(): Env {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');

      console.error('❌ Invalid environment configuration:\n' + issues);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Global environment configuration instance
 */
export const env = parseEnv();

/**
 * Database Configuration
 */
export const databaseConfig = {
  url: env.DATABASE_URL,
  pool: {
    min: env.DATABASE_POOL_MIN,
    max: env.DATABASE_POOL_MAX,
  },
} as const;

/**
 * Redis Configuration
 */
export const redisConfig = {
  url: env.REDIS_URL,
  maxRetries: env.REDIS_MAX_RETRIES,
  retryDelayMs: env.REDIS_RETRY_DELAY_MS,
} as const;

/**
 * API Configuration
 *
 * An empty trusted-proxy list is the secure default: forwarded client IP
 * headers are ignored. Deployments behind a proxy must name its IP/CIDR
 * explicitly (comma-separated) before Fastify will trust forwarded addresses.
 */
export const apiConfig = {
  trustedProxies: env.API_TRUSTED_PROXIES.split(',')
    .map((proxy) => proxy.trim())
    .filter((proxy) => proxy.length > 0),
  shutdownTimeoutMs: env.API_SHUTDOWN_TIMEOUT_MS,
} as const;

/**
 * Worker Configuration
 */
export const workerConfig = {
  concurrency: env.WORKER_CONCURRENCY,
  queues: env.WORKER_QUEUES.split(','),
  heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
  leaseDurationMs: env.WORKER_LEASE_DURATION_MS,
} as const;

/**
 * Job Configuration
 */
export const jobConfig = {
  defaultTimeoutMs: env.JOB_DEFAULT_TIMEOUT_MS,
  defaultMaxAttempts: env.JOB_DEFAULT_MAX_ATTEMPTS,
  retryBaseDelayMs: env.JOB_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: env.JOB_RETRY_MAX_DELAY_MS,
} as const;

/**
 * Rate Limiting Configuration
 */
export const rateLimitConfig = {
  windowSeconds: 60,
  jobSubmissionPerWindow: env.RATE_LIMIT_JOB_SUBMISSION_PER_MIN,
  mutationPerWindow: env.RATE_LIMIT_MUTATION_PER_MIN,
  readPerWindow: env.RATE_LIMIT_READ_PER_MIN,
  metricsPerWindow: env.RATE_LIMIT_METRICS_PER_MIN,
} as const;

/**
 * Security Configuration
 */
export const securityConfig = {
  jwtSecret: env.JWT_SECRET,
  apiKeyHashSalt: env.API_KEY_HASH_SALT,
} as const;

/**
 * Observability Configuration
 */
export const observabilityConfig = {
  enableMetrics: env.ENABLE_METRICS,
  metricsPort: env.METRICS_PORT,
  workerMetricsPort: env.WORKER_METRICS_PORT,
  workerMetricsHost: env.WORKER_METRICS_HOST,
  enableTracing: env.ENABLE_TRACING,
  otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
} as const;

/**
 * Dispatch Configuration
 */
export const dispatchConfig = {
  maxInFlightPerQueue: env.DISPATCH_MAX_IN_FLIGHT_PER_QUEUE,
} as const;

/**
 * Retention Configuration
 */
export const retentionConfig = {
  jobsCompletedDays: env.RETENTION_JOBS_DAYS,
  jobEventsDays: env.RETENTION_EVENTS_DAYS,
  jobAttemptsDays: env.RETENTION_ATTEMPTS_DAYS,
  deadLettersDays: env.RETENTION_DEAD_LETTERS_DAYS,
  deliveriesDays: env.RETENTION_DELIVERIES_DAYS,
  workersDays: env.RETENTION_WORKERS_DAYS,
  idempotencyKeysHours: env.RETENTION_IDEMPOTENCY_KEYS_HOURS,
  auditLogsDays: env.RETENTION_AUDIT_LOGS_DAYS,
  redisStreamMaxLen: env.RETENTION_REDIS_STREAM_MAX_LEN,
  batchSize: env.RETENTION_BATCH_SIZE,
  enabled: env.RETENTION_ENABLED,
  intervalMs: env.RETENTION_INTERVAL_MS,
} as const;

/**
 * Check if running in production
 */
export const isProduction = env.NODE_ENV === 'production';

/**
 * Check if running in development
 */
export const isDevelopment = env.NODE_ENV === 'development';

/**
 * Check if running in test
 */
export const isTest = env.NODE_ENV === 'test';
