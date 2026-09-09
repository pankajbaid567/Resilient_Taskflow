import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import path from 'path';

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

  // PostgreSQL
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDIS_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  REDIS_RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),

  // Kafka/Redpanda
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('taskflow'),
  KAFKA_GROUP_ID: z.string().default('taskflow-workers'),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_QUEUES: z.string().default('default'),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10000),
  WORKER_LEASE_DURATION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30000),

  // Job Configuration
  JOB_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  JOB_DEFAULT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JOB_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),
  JOB_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(60000),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // Security
  JWT_SECRET: z.string().min(32),
  API_KEY_HASH_SALT: z.string().min(16),

  // Observability
  ENABLE_METRICS: z.coerce.boolean().default(true),
  METRICS_PORT: z.coerce.number().int().positive().default(9090),
  ENABLE_TRACING: z.coerce.boolean().default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .url()
    .default('http://localhost:4318'),
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
        .map(
          (issue) =>
            `  - ${issue.path.join('.')}: ${issue.message}`
        )
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
 * Kafka Configuration
 */
export const kafkaConfig = {
  brokers: env.KAFKA_BROKERS.split(','),
  clientId: env.KAFKA_CLIENT_ID,
  groupId: env.KAFKA_GROUP_ID,
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
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
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
  enableTracing: env.ENABLE_TRACING,
  otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
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
