import { env, isDevelopment } from '@taskflow/config';
import pino from 'pino';

/**
 * Create Pino Logger Instance
 *
 * Configuration:
 * - Development: Pretty-printed with colors
 * - Production: JSON structured logs
 * - Never log sensitive data (passwords, tokens, payloads with PII)
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print in development
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // Redact sensitive fields
  redact: {
    paths: [
      'password',
      'passwordHash',
      'apiKey',
      'apiKeyHash',
      'jwtSecret',
      '*.password',
      '*.token',
      '*.apiKey',
      'payload.password',
      'payload.creditCard',
      'payload.ssn',
    ],
    remove: true,
  },
});

/**
 * Create child logger with additional context
 */
export function createLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Request logger for HTTP requests
 */
export function createRequestLogger(requestId: string): pino.Logger {
  return logger.child({ requestId });
}

/**
 * Job logger for job processing
 */
export function createJobLogger(jobId: string, workerId?: string): pino.Logger {
  return logger.child({ jobId, workerId });
}

/**
 * Worker logger for worker lifecycle
 */
export function createWorkerLogger(workerId: string): pino.Logger {
  return logger.child({ workerId });
}

export default logger;
