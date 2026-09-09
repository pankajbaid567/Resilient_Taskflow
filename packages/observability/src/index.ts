/**
 * @taskflow/observability
 * 
 * Comprehensive observability for distributed task queue:
 * - Prometheus metrics (prom-client)
 * - OpenTelemetry distributed tracing
 * - Pre-configured instrumentations
 */

// Metrics
export * from './metrics';

// Tracing
export * from './tracing';

// Re-export OpenTelemetry API for convenience
export { Span, SpanStatusCode, Context } from '@opentelemetry/api';
