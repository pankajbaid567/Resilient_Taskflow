import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  trace,
  context,
  Context,
  Span,
  SpanStatusCode,
  Tracer,
} from '@opentelemetry/api';

import { env } from '@taskflow/config';
import { createLogger } from '@taskflow/logger';

const logger = createLogger({ component: 'Tracing' });

/**
 * OpenTelemetry SDK Instance
 */
let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry Tracing
 * 
 * Automatically instruments:
 * - HTTP/HTTPS
 * - Fastify
 * - PostgreSQL
 * - Redis
 * - DNS
 * - Net
 * 
 * Exports traces to OTLP collector (Jaeger, Tempo, etc.)
 */
export function initializeTracing(serviceName: string): NodeSDK {
  if (sdk) {
    logger.warn('Tracing already initialized');
    return sdk;
  }

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: '1.0.0',
  });

  const traceExporter = new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: undefined, // Use Prometheus for metrics
    instrumentations: [
      getNodeAutoInstrumentations({
        // Fastify
        '@opentelemetry/instrumentation-fastify': {
          enabled: true,
        },
        // HTTP/HTTPS
        '@opentelemetry/instrumentation-http': {
          enabled: true,
          requestHook: (span: Span, request: any) => {
            span.setAttribute('http.request_id', request.headers['x-request-id'] || 'unknown');
          },
        },
        // PostgreSQL
        '@opentelemetry/instrumentation-pg': {
          enabled: true,
          enhancedDatabaseReporting: true,
        },
        // Redis
        '@opentelemetry/instrumentation-redis-4': {
          enabled: true,
        },
        // DNS
        '@opentelemetry/instrumentation-dns': {
          enabled: true,
        },
        // Net
        '@opentelemetry/instrumentation-net': {
          enabled: true,
        },
      }),
    ],
  });

  sdk.start();

  logger.info('OpenTelemetry tracing initialized', {
    serviceName,
    exporterUrl: env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    sdk
      ?.shutdown()
      .then(() => logger.info('OpenTelemetry SDK shut down successfully'))
      .catch((error) => logger.error('Error shutting down OpenTelemetry SDK', { error }));
  });

  return sdk;
}

/**
 * Get current tracer
 */
export function getTracer(name: string = 'taskflow'): Tracer {
  return trace.getTracer(name);
}

/**
 * Create a new span for custom instrumentation
 * 
 * Example:
 * ```typescript
 * const span = startSpan('processJob', { jobId: '123' });
 * try {
 *   // ... do work
 *   span.setStatus({ code: SpanStatusCode.OK });
 * } catch (error) {
 *   recordError(span, error);
 * } finally {
 *   endSpan(span);
 * }
 * ```
 */
export function startSpan(name: string, attributes?: Record<string, any>): Span {
  const tracer = getTracer();
  const span = tracer.startSpan(name, {
    attributes: attributes || {},
  });
  return span;
}

/**
 * End a span
 */
export function endSpan(span: Span): void {
  span.end();
}

/**
 * Record an error in a span
 */
export function recordError(span: Span, error: Error): void {
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

/**
 * Add attributes to current span
 */
export function addSpanAttributes(attributes: Record<string, any>): void {
  const span = trace.getActiveSpan();
  if (span) {
    Object.entries(attributes).forEach(([key, value]) => {
      span.setAttribute(key, value);
    });
  }
}

/**
 * Add event to current span
 */
export function addSpanEvent(name: string, attributes?: Record<string, any>): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Execute function within a span context
 * 
 * Example:
 * ```typescript
 * await withSpan('processJob', { jobId: '123' }, async (span) => {
 *   // ... do work
 *   span.setAttribute('result', 'success');
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, any>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      recordError(span, error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Execute function with specific context
 */
export function withContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}

/**
 * Get current context
 */
export function getCurrentContext(): Context {
  return context.active();
}

/**
 * Create a child context with span
 */
export function createContextWithSpan(span: Span): Context {
  return trace.setSpan(context.active(), span);
}

/**
 * Job-specific tracing helpers
 */
export const JobTracing = {
  /**
   * Start job processing span
   */
  startJobProcessing(jobId: string, jobType: string, queue: string): Span {
    return startSpan('job.process', {
      'job.id': jobId,
      'job.type': jobType,
      'job.queue': queue,
    });
  },

  /**
   * Record job submission
   */
  recordJobSubmission(jobId: string, jobType: string, queue: string): void {
    addSpanEvent('job.submitted', {
      'job.id': jobId,
      'job.type': jobType,
      'job.queue': queue,
    });
  },

  /**
   * Record job enqueued
   */
  recordJobEnqueued(jobId: string, queue: string): void {
    addSpanEvent('job.enqueued', {
      'job.id': jobId,
      'job.queue': queue,
    });
  },

  /**
   * Record job started
   */
  recordJobStarted(jobId: string, workerId: string): void {
    addSpanEvent('job.started', {
      'job.id': jobId,
      'worker.id': workerId,
    });
  },

  /**
   * Record job completed
   */
  recordJobCompleted(jobId: string, durationMs: number): void {
    addSpanEvent('job.completed', {
      'job.id': jobId,
      'job.duration_ms': durationMs,
    });
  },

  /**
   * Record job failed
   */
  recordJobFailed(jobId: string, error: Error, attempt: number): void {
    addSpanEvent('job.failed', {
      'job.id': jobId,
      'error.message': error.message,
      'error.type': error.name,
      'job.attempt': attempt,
    });
  },

  /**
   * Record job retry
   */
  recordJobRetry(jobId: string, attempt: number, nextRetryMs: number): void {
    addSpanEvent('job.retry', {
      'job.id': jobId,
      'job.attempt': attempt,
      'job.next_retry_ms': nextRetryMs,
    });
  },

  /**
   * Record job cancelled
   */
  recordJobCancelled(jobId: string): void {
    addSpanEvent('job.cancelled', {
      'job.id': jobId,
    });
  },
};

/**
 * Worker-specific tracing helpers
 */
export const WorkerTracing = {
  /**
   * Start worker lifecycle span
   */
  startWorkerLifecycle(workerId: string): Span {
    return startSpan('worker.lifecycle', {
      'worker.id': workerId,
    });
  },

  /**
   * Record worker heartbeat
   */
  recordWorkerHeartbeat(workerId: string, jobCount: number): void {
    addSpanEvent('worker.heartbeat', {
      'worker.id': workerId,
      'worker.job_count': jobCount,
    });
  },

  /**
   * Record lease acquisition
   */
  recordLeaseAcquisition(jobId: string, workerId: string, leaseMs: number): void {
    addSpanEvent('lease.acquired', {
      'job.id': jobId,
      'worker.id': workerId,
      'lease.duration_ms': leaseMs,
    });
  },

  /**
   * Record lease renewal
   */
  recordLeaseRenewal(jobId: string, workerId: string): void {
    addSpanEvent('lease.renewed', {
      'job.id': jobId,
      'worker.id': workerId,
    });
  },
};

/**
 * Queue-specific tracing helpers
 */
export const QueueTracing = {
  /**
   * Record message enqueued
   */
  recordMessageEnqueued(queue: string, messageId: string): void {
    addSpanEvent('queue.enqueued', {
      'queue.name': queue,
      'message.id': messageId,
    });
  },

  /**
   * Record message consumed
   */
  recordMessageConsumed(queue: string, messageId: string): void {
    addSpanEvent('queue.consumed', {
      'queue.name': queue,
      'message.id': messageId,
    });
  },

  /**
   * Record message acknowledged
   */
  recordMessageAcknowledged(queue: string, messageId: string): void {
    addSpanEvent('queue.acknowledged', {
      'queue.name': queue,
      'message.id': messageId,
    });
  },
};

/**
 * Shutdown tracing (for graceful shutdown)
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    logger.info('OpenTelemetry SDK shut down');
  }
}

export default {
  initializeTracing,
  getTracer,
  startSpan,
  endSpan,
  recordError,
  addSpanAttributes,
  addSpanEvent,
  withSpan,
  withContext,
  getCurrentContext,
  createContextWithSpan,
  JobTracing,
  WorkerTracing,
  QueueTracing,
  shutdownTracing,
};
