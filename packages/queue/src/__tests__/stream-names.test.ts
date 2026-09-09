import { describe, expect, it } from 'vitest';

import {
  JOB_STREAM_PREFIX,
  JOB_STREAM_SUFFIX,
  WORKER_CONSUMER_GROUP,
  WORKER_CONSUMER_PREFIX,
  getConsumerGroupName,
  getConsumerName,
  getStreamKey,
  parseQueueFromStreamKey,
} from '../stream-names';

describe('Stream Naming', () => {
  it('exports the authoritative stream and consumer-group constants', () => {
    expect(JOB_STREAM_PREFIX).toBe('taskflow:queue');
    expect(JOB_STREAM_SUFFIX).toBe('jobs');
    expect(WORKER_CONSUMER_GROUP).toBe('taskflow:workers');
    expect(WORKER_CONSUMER_PREFIX).toBe('worker');
  });

  describe('getStreamKey', () => {
    it('should generate correct stream key', () => {
      expect(getStreamKey('default')).toBe('taskflow:queue:default:jobs');
      expect(getStreamKey('email')).toBe('taskflow:queue:email:jobs');
      expect(getStreamKey('critical')).toBe('taskflow:queue:critical:jobs');
    });
  });

  describe('getConsumerGroupName', () => {
    it('should return consistent group name', () => {
      expect(getConsumerGroupName()).toBe(WORKER_CONSUMER_GROUP);
    });
  });

  describe('getConsumerName', () => {
    it('should generate consumer name from worker ID', () => {
      expect(getConsumerName('worker-01')).toBe('worker:worker-01');
      expect(getConsumerName('abc123')).toBe('worker:abc123');
    });
  });

  describe('parseQueueFromStreamKey', () => {
    it('should extract queue name from stream key', () => {
      expect(parseQueueFromStreamKey('taskflow:queue:default:jobs')).toBe(
        'default'
      );
      expect(parseQueueFromStreamKey('taskflow:queue:email:jobs')).toBe(
        'email'
      );
    });

    it('should return null for invalid stream key', () => {
      expect(parseQueueFromStreamKey('invalid:key')).toBeNull();
      expect(parseQueueFromStreamKey('taskflow:queue:default')).toBeNull();
    });
  });
});
