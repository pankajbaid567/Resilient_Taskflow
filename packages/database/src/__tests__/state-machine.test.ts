import { JobStatus } from '@taskflow/types';
import { describe, expect, it } from 'vitest';

import {
  getValidTransitions,
  InvalidStateTransitionError,
  isTerminalState,
  isValidTransition,
  TERMINAL_STATES,
  validateTransition,
} from '../state-machine';

describe('Job State Machine', () => {
  describe('isValidTransition', () => {
    it('should allow CREATED -> QUEUED', () => {
      expect(isValidTransition(JobStatus.CREATED, JobStatus.QUEUED)).toBe(true);
    });

    it('should allow CREATED -> CANCELLED', () => {
      expect(isValidTransition(JobStatus.CREATED, JobStatus.CANCELLED)).toBe(
        true
      );
    });

    it('should allow QUEUED -> PROCESSING', () => {
      expect(isValidTransition(JobStatus.QUEUED, JobStatus.PROCESSING)).toBe(
        true
      );
    });

    it('should allow PROCESSING -> SUCCEEDED', () => {
      expect(isValidTransition(JobStatus.PROCESSING, JobStatus.SUCCEEDED)).toBe(
        true
      );
    });

    it('should allow PROCESSING -> FAILED', () => {
      expect(isValidTransition(JobStatus.PROCESSING, JobStatus.FAILED)).toBe(
        true
      );
    });

    it('should allow PROCESSING -> RETRY_SCHEDULED', () => {
      expect(
        isValidTransition(JobStatus.PROCESSING, JobStatus.RETRY_SCHEDULED)
      ).toBe(true);
    });

    it('should allow FAILED -> RETRY_SCHEDULED', () => {
      expect(
        isValidTransition(JobStatus.FAILED, JobStatus.RETRY_SCHEDULED)
      ).toBe(true);
    });

    it('should allow RETRY_SCHEDULED -> QUEUED', () => {
      expect(
        isValidTransition(JobStatus.RETRY_SCHEDULED, JobStatus.QUEUED)
      ).toBe(true);
    });

    it('should allow PROCESSING -> CANCEL_REQUESTED', () => {
      expect(
        isValidTransition(JobStatus.PROCESSING, JobStatus.CANCEL_REQUESTED)
      ).toBe(true);
    });

    it('should allow CANCEL_REQUESTED -> CANCELLED', () => {
      expect(
        isValidTransition(JobStatus.CANCEL_REQUESTED, JobStatus.CANCELLED)
      ).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('should reject SUCCEEDED -> PROCESSING', () => {
      expect(isValidTransition(JobStatus.SUCCEEDED, JobStatus.PROCESSING)).toBe(
        false
      );
    });

    it('should reject CANCELLED -> QUEUED', () => {
      expect(isValidTransition(JobStatus.CANCELLED, JobStatus.QUEUED)).toBe(
        false
      );
    });

    it('should reject DEAD_LETTERED -> PROCESSING', () => {
      expect(
        isValidTransition(JobStatus.DEAD_LETTERED, JobStatus.PROCESSING)
      ).toBe(false);
    });

    it('should reject CREATED -> PROCESSING (skip QUEUED)', () => {
      expect(isValidTransition(JobStatus.CREATED, JobStatus.PROCESSING)).toBe(
        false
      );
    });

    it('should reject QUEUED -> SUCCEEDED (skip PROCESSING)', () => {
      expect(isValidTransition(JobStatus.QUEUED, JobStatus.SUCCEEDED)).toBe(
        false
      );
    });
  });

  describe('validateTransition', () => {
    it('should not throw for valid transitions', () => {
      expect(() => {
        validateTransition(JobStatus.CREATED, JobStatus.QUEUED);
      }).not.toThrow();
    });

    it('should throw InvalidStateTransitionError for invalid transitions', () => {
      expect(() => {
        validateTransition(JobStatus.SUCCEEDED, JobStatus.PROCESSING);
      }).toThrow(InvalidStateTransitionError);
    });

    it('should include helpful error message', () => {
      try {
        validateTransition(JobStatus.SUCCEEDED, JobStatus.PROCESSING);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidStateTransitionError);
        expect((error as Error).message).toContain('Invalid state transition');
        expect((error as Error).message).toContain('SUCCEEDED');
        expect((error as Error).message).toContain('PROCESSING');
      }
    });
  });

  describe('isTerminalState', () => {
    it('should identify SUCCEEDED as terminal', () => {
      expect(isTerminalState(JobStatus.SUCCEEDED)).toBe(true);
    });

    it('should identify CANCELLED as terminal', () => {
      expect(isTerminalState(JobStatus.CANCELLED)).toBe(true);
    });

    it('should identify DEAD_LETTERED as terminal', () => {
      expect(isTerminalState(JobStatus.DEAD_LETTERED)).toBe(true);
    });

    it('should not identify PROCESSING as terminal', () => {
      expect(isTerminalState(JobStatus.PROCESSING)).toBe(false);
    });

    it('should not identify QUEUED as terminal', () => {
      expect(isTerminalState(JobStatus.QUEUED)).toBe(false);
    });
  });

  describe('getValidTransitions', () => {
    it('should return valid transitions for CREATED', () => {
      const transitions = getValidTransitions(JobStatus.CREATED);
      expect(transitions).toEqual([JobStatus.QUEUED, JobStatus.CANCELLED]);
    });

    it('should return empty array for terminal states', () => {
      expect(getValidTransitions(JobStatus.SUCCEEDED)).toEqual([]);
      expect(getValidTransitions(JobStatus.CANCELLED)).toEqual([]);
      expect(getValidTransitions(JobStatus.DEAD_LETTERED)).toEqual([]);
    });

    it('should return all possible transitions for PROCESSING', () => {
      const transitions = getValidTransitions(JobStatus.PROCESSING);
      expect(transitions).toContain(JobStatus.SUCCEEDED);
      expect(transitions).toContain(JobStatus.FAILED);
      expect(transitions).toContain(JobStatus.RETRY_SCHEDULED);
      expect(transitions).toContain(JobStatus.DEAD_LETTERED);
      expect(transitions).toContain(JobStatus.CANCEL_REQUESTED);
    });
  });

  describe('TERMINAL_STATES constant', () => {
    it('should contain all terminal states', () => {
      expect(TERMINAL_STATES).toContain(JobStatus.SUCCEEDED);
      expect(TERMINAL_STATES).toContain(JobStatus.CANCELLED);
      expect(TERMINAL_STATES).toContain(JobStatus.DEAD_LETTERED);
      expect(TERMINAL_STATES).toHaveLength(3);
    });
  });

  describe('state machine completeness', () => {
    it('should have transitions defined for all job statuses', () => {
      const allStatuses = Object.values(JobStatus);
      allStatuses.forEach((status) => {
        expect(() => getValidTransitions(status)).not.toThrow();
      });
    });

    it('should not allow transitions from terminal states', () => {
      TERMINAL_STATES.forEach((terminalState) => {
        const transitions = getValidTransitions(terminalState);
        expect(transitions).toEqual([]);
      });
    });
  });
});
