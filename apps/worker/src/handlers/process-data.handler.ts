/**
 * Process Data Handler
 *
 * Example handler for data processing tasks.
 * Demonstrates CPU-intensive work and error handling.
 */

import { createLogger } from '@taskflow/logger';
import type { JobHandlerContext } from '@taskflow/types';
import { PermanentJobError } from '@taskflow/worker';

const logger = createLogger({ component: 'ProcessDataHandler' });

/**
 * Data processing payload schema
 */
interface ProcessDataPayload {
  operation: 'transform' | 'aggregate' | 'validate' | 'enrich';
  data: Record<string, unknown>[];
  options?: {
    batchSize?: number;
    timeout?: number;
  };
}

/**
 * Process data handler
 *
 * IMPORTANT: This handler must be idempotent!
 * - Check if processing already done
 * - Use deterministic operations
 */
export async function processDataHandler(
  payloadInput: Record<string, unknown>,
  context: JobHandlerContext
): Promise<Record<string, unknown>> {
  const startTime = Date.now();
  const jobId = context.job.id;

  try {
    logger.info('Processing data job', {
      jobId,
      attempt: context.job.attempts,
      maxAttempts: context.job.maxAttempts,
    });

    // Validate payload
    const payload = validateDataPayload(payloadInput);

    logger.debug('Processing data', {
      jobId,
      operation: payload.operation,
      recordCount: payload.data.length,
    });

    // Process data based on operation type
    let result: Record<string, unknown>;

    switch (payload.operation) {
      case 'transform':
        result = await transformData(payload.data, jobId);
        break;

      case 'aggregate':
        result = await aggregateData(payload.data, jobId);
        break;

      case 'validate':
        result = await validateData(payload.data, jobId);
        break;

      case 'enrich':
        result = await enrichData(payload.data, jobId);
        break;

      default:
        throw new Error('Unknown data-processing operation');
    }

    const duration = Date.now() - startTime;

    logger.info('Data processed successfully', {
      jobId,
      operation: payload.operation,
      recordCount: payload.data.length,
      duration,
    });

    return {
      operation: payload.operation,
      recordsProcessed: payload.data.length,
      duration,
      ...result,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error('Failed to process data', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
      duration,
    });

    throw error;
  }
}

/**
 * Validate data processing payload
 */
function validateDataPayload(
  payload: Record<string, unknown>
): ProcessDataPayload {
  if (!payload.operation || typeof payload.operation !== 'string') {
    throw new PermanentJobError(
      'Operation field is required',
      'INVALID_PAYLOAD'
    );
  }

  const validOperations = ['transform', 'aggregate', 'validate', 'enrich'];
  if (!validOperations.includes(payload.operation)) {
    throw new PermanentJobError(
      `Invalid operation: ${payload.operation}`,
      'INVALID_PAYLOAD'
    );
  }

  if (!Array.isArray(payload.data)) {
    throw new PermanentJobError(
      'Data field must be an array',
      'INVALID_PAYLOAD'
    );
  }

  if (payload.data.length === 0) {
    throw new PermanentJobError(
      'Data array cannot be empty',
      'INVALID_PAYLOAD'
    );
  }

  if (payload.data.length > 10000) {
    throw new PermanentJobError(
      'Data array too large (max 10,000 records)',
      'INVALID_PAYLOAD'
    );
  }

  return payload as unknown as ProcessDataPayload;
}

/**
 * Transform data records
 */
async function transformData(
  data: Record<string, unknown>[],
  jobId: string
): Promise<Record<string, unknown>> {
  // Simulate CPU-intensive transformation
  const transformed = data.map((record) => ({
    ...record,
    transformed: true,
    transformedAt: new Date().toISOString(),
    transformedBy: jobId,
  }));

  // Simulate some processing time
  await new Promise((resolve) => setTimeout(resolve, 50));

  logger.debug('Data transformed', {
    jobId,
    count: transformed.length,
  });

  return {
    transformed: transformed,
    count: transformed.length,
  };
}

/**
 * Aggregate data records
 */
async function aggregateData(
  data: Record<string, unknown>[],
  jobId: string
): Promise<Record<string, unknown>> {
  // Simulate aggregation
  const stats = {
    total: data.length,
    aggregatedAt: new Date().toISOString(),
    aggregatedBy: jobId,
    // Example aggregations
    numericFields: 0,
    stringFields: 0,
    objectFields: 0,
  };

  // Count field types
  for (const record of data) {
    for (const value of Object.values(record)) {
      if (typeof value === 'number') stats.numericFields++;
      else if (typeof value === 'string') stats.stringFields++;
      else if (typeof value === 'object') stats.objectFields++;
    }
  }

  // Simulate processing time
  await new Promise((resolve) => setTimeout(resolve, 50));

  logger.debug('Data aggregated', { jobId, stats });

  return {
    aggregation: stats,
  };
}

/**
 * Validate data records
 */
async function validateData(
  data: Record<string, unknown>[],
  jobId: string
): Promise<Record<string, unknown>> {
  const errors: Array<{ index: number; error: string }> = [];

  // Validate each record
  for (let i = 0; i < data.length; i++) {
    const record = data[i];

    if (!record) {
      errors.push({ index: i, error: 'Missing record' });
      continue;
    }

    // Example validation rules
    if (!record.id) {
      errors.push({ index: i, error: 'Missing id field' });
    }

    if (typeof record.value !== 'number') {
      errors.push({ index: i, error: 'Value field must be a number' });
    }
  }

  // Simulate processing time
  await new Promise((resolve) => setTimeout(resolve, 50));

  const isValid = errors.length === 0;

  logger.debug('Data validated', {
    jobId,
    isValid,
    errorCount: errors.length,
  });

  return {
    isValid,
    errorCount: errors.length,
    errors: errors.slice(0, 100), // Limit error list
  };
}

/**
 * Enrich data records
 */
async function enrichData(
  data: Record<string, unknown>[],
  jobId: string
): Promise<Record<string, unknown>> {
  // Simulate enrichment from external source
  const enriched = data.map((record) => ({
    ...record,
    enriched: true,
    enrichedAt: new Date().toISOString(),
    enrichedBy: jobId,
    // Add mock enrichment data
    metadata: {
      processed: true,
      source: 'worker',
    },
  }));

  // Simulate API call delay
  await new Promise((resolve) => setTimeout(resolve, 100));

  logger.debug('Data enriched', {
    jobId,
    count: enriched.length,
  });

  return {
    enriched: enriched,
    count: enriched.length,
  };
}
