import { describe, expect, it } from 'vitest';

import * as retentionRepository from '../repositories/retention.repository';

describe('bounded retention repository contract', () => {
  it('exports bounded cleanup handlers for all lifecycle entities', () => {
    const requiredCleaners = [
      'cleanupBoundedJobs',
      'cleanupBoundedJobEvents',
      'cleanupBoundedJobAttempts',
      'cleanupBoundedDeadLetters',
      'cleanupBoundedJobDeliveries',
      'cleanupBoundedWorkers',
      'cleanupBoundedIdempotencyKeys',
      'cleanupBoundedAuditLogs',
      'runDatabaseRetention',
    ];

    for (const cleaner of requiredCleaners) {
      expect(retentionRepository).toHaveProperty(cleaner);
      expect(
        typeof (retentionRepository as Record<string, unknown>)[cleaner]
      ).toBe('function');
    }
  });
});
