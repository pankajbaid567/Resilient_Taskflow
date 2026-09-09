import { describe, expect, it } from 'vitest';

import {
  getConsumerGroupName,
  getConsumerName,
  getStreamKey,
  parseQueueFromStreamKey,
  WORKER_CONSUMER_GROUP,
} from '@taskflow/queue';
import {
  JobStatus,
  parseRedisJobMessage,
  REDIS_JOB_MESSAGE_FIELD,
  REDIS_JOB_MESSAGE_VERSION,
} from '@taskflow/types';

describe('shared queue and lifecycle contract', () => {
  it('derives all Redis identifiers from the canonical definitions', () => {
    const stream = getStreamKey('high-priority');

    expect(stream).toBe('taskflow:queue:high-priority:jobs');
    expect(parseQueueFromStreamKey(stream)).toBe('high-priority');
    expect(parseQueueFromStreamKey('taskflow:queue:high-priority')).toBeNull();
    expect(getConsumerGroupName()).toBe(WORKER_CONSUMER_GROUP);
    expect(WORKER_CONSUMER_GROUP).toBe('taskflow:workers');
    expect(getConsumerName('worker-123')).toBe('worker:worker-123');
  });

  it('accepts the versioned data envelope and rejects legacy shapes', () => {
    const message = {
      schemaVersion: REDIS_JOB_MESSAGE_VERSION,
      jobId: 'job-123',
      enqueuedAt: '2026-09-09T00:00:00.000Z',
      attempt: 1,
      queue: 'default',
    };

    expect(REDIS_JOB_MESSAGE_FIELD).toBe('data');
    expect(parseRedisJobMessage(message)).toEqual(message);
    expect(() =>
      parseRedisJobMessage({ ...message, schemaVersion: '1.0' })
    ).toThrow();
    expect(() =>
      parseRedisJobMessage({ jobId: message.jobId, queue: message.queue })
    ).toThrow();
  });

  it('uses the shared database-compatible lifecycle states', () => {
    expect(Object.values(JobStatus)).toEqual([
      'CREATED',
      'QUEUED',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'RETRY_SCHEDULED',
      'CANCEL_REQUESTED',
      'CANCELLED',
      'DEAD_LETTERED',
    ]);
  });
});
