import { JobStatus } from '@taskflow/types';
import { describe, expect, it } from 'vitest';

import {
  getValidTransitions,
  InvalidStateTransitionError,
  isTerminalState,
  isValidTransition,
  TERMINAL_STATES,
  validateTransition,
  VALID_TRANSITIONS,
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

    it('should allow PROCESSING -> QUEUED (lease recovery and shutdown release)', () => {
      expect(isValidTransition(JobStatus.PROCESSING, JobStatus.QUEUED)).toBe(
        true
      );
    });

    it('should allow CANCEL_REQUESTED -> SUCCEEDED (result committed before the request was observed)', () => {
      expect(
        isValidTransition(JobStatus.CANCEL_REQUESTED, JobStatus.SUCCEEDED)
      ).toBe(true);
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

    it('should reject PROCESSING -> FAILED (the runtime never writes FAILED)', () => {
      expect(isValidTransition(JobStatus.PROCESSING, JobStatus.FAILED)).toBe(
        false
      );
    });

    it('should reject CANCEL_REQUESTED -> RETRY_SCHEDULED (a cancelled job is never retried)', () => {
      expect(
        isValidTransition(JobStatus.CANCEL_REQUESTED, JobStatus.RETRY_SCHEDULED)
      ).toBe(false);
    });

    it('should reject CANCEL_REQUESTED -> QUEUED (a release must not undo a cancel request)', () => {
      expect(
        isValidTransition(JobStatus.CANCEL_REQUESTED, JobStatus.QUEUED)
      ).toBe(false);
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
      expect(transitions).not.toContain(JobStatus.FAILED);
      expect(transitions).toContain(JobStatus.QUEUED);
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

  describe('enforcement contract', () => {
    /**
     * Every status change the repositories perform, with where it happens.
     * Each of these calls validateTransition() immediately before its UPDATE.
     * Adding a transition to the runtime means adding it here AND to
     * VALID_TRANSITIONS, which is the point of this test.
     */
    const REPOSITORY_TRANSITIONS: Array<[JobStatus, JobStatus]> = [
      // createJob / promoteDueScheduledJobs / promoteJobToQueued
      [JobStatus.CREATED, JobStatus.QUEUED],
      // cancelJobForUser
      [JobStatus.CREATED, JobStatus.CANCELLED],
      [JobStatus.QUEUED, JobStatus.CANCELLED],
      [JobStatus.RETRY_SCHEDULED, JobStatus.CANCELLED],
      [JobStatus.PROCESSING, JobStatus.CANCEL_REQUESTED],
      // acquireJobForDelivery
      [JobStatus.QUEUED, JobStatus.PROCESSING],
      [JobStatus.RETRY_SCHEDULED, JobStatus.QUEUED],
      [JobStatus.PROCESSING, JobStatus.QUEUED],
      [JobStatus.PROCESSING, JobStatus.DEAD_LETTERED],
      [JobStatus.CANCEL_REQUESTED, JobStatus.CANCELLED],
      // completeJobDelivery
      [JobStatus.PROCESSING, JobStatus.SUCCEEDED],
      [JobStatus.CANCEL_REQUESTED, JobStatus.SUCCEEDED],
      // failJobDelivery
      [JobStatus.PROCESSING, JobStatus.RETRY_SCHEDULED],
      // releaseJobDelivery: PROCESSING -> QUEUED (listed above)
    ];

    const key = ([from, to]: [string, string]): string => `${from}->${to}`;

    it('permits every transition the repositories perform', () => {
      for (const [from, to] of REPOSITORY_TRANSITIONS) {
        expect(isValidTransition(from, to), key([from, to])).toBe(true);
      }
    });

    it('permits nothing the repositories never perform, except legacy FAILED exits', () => {
      const table = Object.entries(VALID_TRANSITIONS)
        .filter(([from]) => from !== String(JobStatus.FAILED))
        .flatMap(([from, targets]) => targets.map((to) => key([from, to])))
        .sort();

      expect(table).toEqual(REPOSITORY_TRANSITIONS.map(key).sort());
    });

    it('has no way into the legacy FAILED state', () => {
      const entering = Object.entries(VALID_TRANSITIONS).filter(([, targets]) =>
        targets.includes(JobStatus.FAILED)
      );
      expect(entering).toEqual([]);
    });
  });
});
