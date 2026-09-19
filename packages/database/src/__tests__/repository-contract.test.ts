import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as jobRepository from '../repositories/job.repository';
import { idempotencyKeys, jobDeliveries, jobEvents, jobs } from '../schema';

describe('canonical persistence boundary', () => {
  it('does not export legacy worker mutation bypasses', () => {
    const removedMutations = [
      'updateJobStatus',
      'acquireJobLease',
      'renewJobLease',
      'releaseJobLease',
      'completeJob',
      'failJob',
      'scheduleJobRetry',
      'moveJobToDeadLetter',
    ];

    for (const mutation of removedMutations) {
      expect(jobRepository).not.toHaveProperty(mutation);
    }
  });

  it('requires one positive, unique event sequence per job', () => {
    const jobsConfig = getTableConfig(jobs);
    const eventsConfig = getTableConfig(jobEvents);
    const jobCounter = jobsConfig.columns.find(
      (column) => column.name === 'event_sequence'
    );
    const eventSequence = eventsConfig.columns.find(
      (column) => column.name === 'event_sequence'
    );
    const uniqueSequence = eventsConfig.uniqueConstraints.find(
      (constraint) => constraint.name === 'job_events_job_sequence_unique'
    );

    expect(jobCounter).toMatchObject({ notNull: true, default: 0 });
    expect(eventSequence).toMatchObject({ notNull: true });
    expect(uniqueSequence?.columns.map((column) => column.name)).toEqual([
      'job_id',
      'event_sequence',
    ]);
    expect(eventsConfig.checks.map((check) => check.name)).toContain(
      'job_events_event_sequence_positive'
    );
  });

  it('requires a durable due time on every delivery intent', () => {
    const deliveriesConfig = getTableConfig(jobDeliveries);
    const availableAt = deliveriesConfig.columns.find(
      (column) => column.name === 'available_at'
    );

    expect(availableAt).toMatchObject({ notNull: true, hasDefault: true });
    expect(
      deliveriesConfig.uniqueConstraints
        .find(
          (constraint) =>
            constraint.name === 'job_deliveries_job_id_attempt_key'
        )
        ?.columns.map((column) => column.name)
    ).toEqual(['job_id', 'attempt']);
    expect(
      deliveriesConfig.indexes
        .find((index) => index.config.name === 'idx_job_deliveries_pending')
        ?.config.columns.map((column) =>
          'name' in column ? column.name : undefined
        )
    ).toEqual(['available_at', 'created_at']);
  });

  it('declares the plain active-idempotency lookup index in Drizzle', () => {
    expect(
      getTableConfig(idempotencyKeys).indexes.map((index) => index.config.name)
    ).toContain('idx_idempotency_keys_active');
  });
});
