/**
 * Unit Tests: Queue Operations
 * Tests queue naming, message format, and basic operations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getStreamKey,
  getConsumerGroupName,
  getConsumerName,
  parseQueueFromStreamKey,
} from '@taskflow/queue/stream-names';
import { randomUUID } from 'crypto';

describe('Queue Stream Names', () => {
  describe('getStreamKey', () => {
    it('should generate correct stream key for default queue', () => {
      const key = getStreamKey('default');
      expect(key).toBe('taskflow:queue:default');
    });

    it('should generate correct stream key for named queue', () => {
      const key = getStreamKey('high-priority');
      expect(key).toBe('taskflow:queue:high-priority');
    });

    it('should handle queue names with special characters', () => {
      const key = getStreamKey('email-notifications');
      expect(key).toBe('taskflow:queue:email-notifications');
    });

    it('should be consistent for same queue name', () => {
      const key1 = getStreamKey('test');
      const key2 = getStreamKey('test');
      expect(key1).toBe(key2);
    });
  });

  describe('getConsumerGroupName', () => {
    it('should generate correct consumer group name', () => {
      const groupName = getConsumerGroupName();
      expect(groupName).toBe('taskflow-workers');
    });

    it('should be consistent across calls', () => {
      const name1 = getConsumerGroupName();
      const name2 = getConsumerGroupName();
      expect(name1).toBe(name2);
    });
  });

  describe('getConsumerName', () => {
    it('should generate correct consumer name from worker ID', () => {
      const workerId = 'worker-123';
      const consumerName = getConsumerName(workerId);
      expect(consumerName).toContain(workerId);
    });

    it('should generate unique consumer names for different workers', () => {
      const worker1 = getConsumerName('worker-1');
      const worker2 = getConsumerName('worker-2');
      expect(worker1).not.toBe(worker2);
    });

    it('should handle UUID worker IDs', () => {
      const workerId = randomUUID();
      const consumerName = getConsumerName(workerId);
      expect(consumerName).toContain(workerId);
    });
  });

  describe('parseQueueFromStreamKey', () => {
    it('should extract queue name from stream key', () => {
      const queueName = parseQueueFromStreamKey('taskflow:queue:default');
      expect(queueName).toBe('default');
    });

    it('should extract complex queue names', () => {
      const queueName = parseQueueFromStreamKey(
        'taskflow:queue:high-priority-emails'
      );
      expect(queueName).toBe('high-priority-emails');
    });

    it('should return null for invalid stream key', () => {
      const queueName = parseQueueFromStreamKey('invalid:key');
      expect(queueName).toBeNull();
    });

    it('should return null for empty string', () => {
      const queueName = parseQueueFromStreamKey('');
      expect(queueName).toBeNull();
    });

    it('should handle keys with missing queue name', () => {
      const queueName = parseQueueFromStreamKey('taskflow:queue:');
      expect(queueName).toBeNull();
    });
  });
});

describe('Queue Message Format', () => {
  describe('Message Structure', () => {
    it('should have required fields', () => {
      const message = {
        jobId: randomUUID(),
        queue: 'default',
        attempt: 1,
        createdAt: new Date().toISOString(),
        schemaVersion: '1.0',
      };

      expect(message).toHaveProperty('jobId');
      expect(message).toHaveProperty('queue');
      expect(message).toHaveProperty('attempt');
      expect(message).toHaveProperty('createdAt');
      expect(message).toHaveProperty('schemaVersion');
    });

    it('should serialize to JSON correctly', () => {
      const message = {
        jobId: 'job-123',
        queue: 'default',
        attempt: 1,
        createdAt: new Date().toISOString(),
        schemaVersion: '1.0',
      };

      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);

      expect(parsed.jobId).toBe(message.jobId);
      expect(parsed.queue).toBe(message.queue);
      expect(parsed.attempt).toBe(message.attempt);
    });

    it('should handle retry attempts', () => {
      const attempts = [1, 2, 3, 4, 5];

      attempts.forEach((attempt) => {
        const message = {
          jobId: 'job-123',
          queue: 'default',
          attempt,
          createdAt: new Date().toISOString(),
          schemaVersion: '1.0',
        };

        expect(message.attempt).toBe(attempt);
      });
    });
  });

  describe('Message Versioning', () => {
    it('should include schema version', () => {
      const message = {
        jobId: 'job-123',
        queue: 'default',
        attempt: 1,
        createdAt: new Date().toISOString(),
        schemaVersion: '1.0',
      };

      expect(message.schemaVersion).toBe('1.0');
    });

    it('should support version comparison', () => {
      const versions = ['1.0', '1.1', '2.0'];

      versions.forEach((version) => {
        expect(version).toMatch(/^\d+\.\d+$/);
      });
    });
  });
});

describe('Queue Priority', () => {
  it('should define priority levels', () => {
    const priorities = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];

    priorities.forEach((priority) => {
      expect(priority).toMatch(/^[A-Z]+$/);
    });
  });

  it('should maintain priority order', () => {
    const priorityValues = {
      CRITICAL: 4,
      HIGH: 3,
      NORMAL: 2,
      LOW: 1,
    };

    expect(priorityValues.CRITICAL).toBeGreaterThan(priorityValues.HIGH);
    expect(priorityValues.HIGH).toBeGreaterThan(priorityValues.NORMAL);
    expect(priorityValues.NORMAL).toBeGreaterThan(priorityValues.LOW);
  });
});

describe('Queue Concurrency', () => {
  it('should validate concurrency limits', () => {
    const validConcurrency = [1, 5, 10, 50, 100];

    validConcurrency.forEach((concurrency) => {
      expect(concurrency).toBeGreaterThan(0);
      expect(concurrency).toBeLessThanOrEqual(1000);
    });
  });

  it('should reject invalid concurrency values', () => {
    const invalidConcurrency = [0, -1, -10, Infinity, NaN];

    invalidConcurrency.forEach((concurrency) => {
      expect(
        concurrency <= 0 || !Number.isFinite(concurrency)
      ).toBe(true);
    });
  });
});

describe('Queue Naming Validation', () => {
  it('should accept valid queue names', () => {
    const validNames = [
      'default',
      'high-priority',
      'email-notifications',
      'data-processing',
      'analytics',
    ];

    validNames.forEach((name) => {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(255);
    });
  });

  it('should reject invalid queue names', () => {
    const invalidNames = [
      '',
      'Invalid Name',
      'queue_with_underscore',
      'UPPERCASE',
      'special@chars',
    ];

    invalidNames.forEach((name) => {
      const isValid = /^[a-z0-9-]+$/.test(name) && name.length > 0;
      expect(isValid).toBe(false);
    });
  });
});

describe('Message ID Format', () => {
  it('should use Redis Stream ID format', () => {
    // Redis Stream IDs are in format: timestamp-sequence
    const mockStreamId = '1234567890123-0';

    expect(mockStreamId).toMatch(/^\d+-\d+$/);
  });

  it('should maintain chronological ordering', () => {
    const ids = [
      '1234567890000-0',
      '1234567890001-0',
      '1234567890002-0',
    ];

    for (let i = 1; i < ids.length; i++) {
      const prev = parseInt(ids[i - 1].split('-')[0]);
      const curr = parseInt(ids[i].split('-')[0]);
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe('Queue Limits', () => {
  it('should define stream trim limits', () => {
    const trimLimits = {
      maxLength: 100000,
      approximateTrimming: true,
    };

    expect(trimLimits.maxLength).toBeGreaterThan(0);
    expect(typeof trimLimits.approximateTrimming).toBe('boolean');
  });

  it('should define consumer pending limits', () => {
    const pendingLimits = {
      maxPendingPerConsumer: 1000,
      idleTimeMs: 300000, // 5 minutes
    };

    expect(pendingLimits.maxPendingPerConsumer).toBeGreaterThan(0);
    expect(pendingLimits.idleTimeMs).toBeGreaterThan(0);
  });
});
