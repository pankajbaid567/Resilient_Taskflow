/**
 * Unit Tests: Job State Machine
 * Tests all valid and invalid state transitions
 */

import { describe, it, expect } from 'vitest';
import {
  canTransition,
  getValidTransitions,
  JobStatus,
} from '@taskflow/database/state-machine';

describe('JobStateMachine', () => {
  describe('Valid Transitions', () => {
    it('should allow CREATED -> QUEUED', () => {
      expect(canTransition('CREATED', 'QUEUED')).toBe(true);
    });

    it('should allow QUEUED -> PROCESSING', () => {
      expect(canTransition('QUEUED', 'PROCESSING')).toBe(true);
    });

    it('should allow PROCESSING -> SUCCEEDED', () => {
      expect(canTransition('PROCESSING', 'SUCCEEDED')).toBe(true);
    });

    it('should allow PROCESSING -> FAILED', () => {
      expect(canTransition('PROCESSING', 'FAILED')).toBe(true);
    });

    it('should allow FAILED -> RETRY_SCHEDULED', () => {
      expect(canTransition('FAILED', 'RETRY_SCHEDULED')).toBe(true);
    });

    it('should allow RETRY_SCHEDULED -> QUEUED', () => {
      expect(canTransition('RETRY_SCHEDULED', 'QUEUED')).toBe(true);
    });

    it('should allow FAILED -> DEAD_LETTERED', () => {
      expect(canTransition('FAILED', 'DEAD_LETTERED')).toBe(true);
    });

    it('should allow QUEUED -> CANCELLED', () => {
      expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    });

    it('should allow PROCESSING -> CANCEL_REQUESTED', () => {
      expect(canTransition('PROCESSING', 'CANCEL_REQUESTED')).toBe(true);
    });

    it('should allow CANCEL_REQUESTED -> CANCELLED', () => {
      expect(canTransition('CANCEL_REQUESTED', 'CANCELLED')).toBe(true);
    });

    it('should allow CANCEL_REQUESTED -> SUCCEEDED (race condition)', () => {
      expect(canTransition('CANCEL_REQUESTED', 'SUCCEEDED')).toBe(true);
    });

    it('should allow CANCEL_REQUESTED -> FAILED (race condition)', () => {
      expect(canTransition('CANCEL_REQUESTED', 'FAILED')).toBe(true);
    });
  });

  describe('Invalid Transitions', () => {
    it('should reject SUCCEEDED -> PROCESSING', () => {
      expect(canTransition('SUCCEEDED', 'PROCESSING')).toBe(false);
    });

    it('should reject CANCELLED -> PROCESSING', () => {
      expect(canTransition('CANCELLED', 'PROCESSING')).toBe(false);
    });

    it('should reject DEAD_LETTERED -> PROCESSING', () => {
      expect(canTransition('DEAD_LETTERED', 'PROCESSING')).toBe(false);
    });

    it('should reject SUCCEEDED -> QUEUED', () => {
      expect(canTransition('SUCCEEDED', 'QUEUED')).toBe(false);
    });

    it('should reject CANCELLED -> QUEUED', () => {
      expect(canTransition('CANCELLED', 'QUEUED')).toBe(false);
    });

    it('should reject CREATED -> SUCCEEDED', () => {
      expect(canTransition('CREATED', 'SUCCEEDED')).toBe(false);
    });

    it('should reject QUEUED -> SUCCEEDED', () => {
      expect(canTransition('QUEUED', 'SUCCEEDED')).toBe(false);
    });

    it('should reject PROCESSING -> DEAD_LETTERED directly', () => {
      expect(canTransition('PROCESSING', 'DEAD_LETTERED')).toBe(false);
    });

    it('should reject RETRY_SCHEDULED -> PROCESSING directly', () => {
      expect(canTransition('RETRY_SCHEDULED', 'PROCESSING')).toBe(false);
    });
  });

  describe('Terminal States', () => {
    const terminalStates: JobStatus[] = [
      'SUCCEEDED',
      'CANCELLED',
      'DEAD_LETTERED',
    ];

    terminalStates.forEach((terminal) => {
      it(`should not allow transitions from ${terminal}`, () => {
        const allStates: JobStatus[] = [
          'CREATED',
          'QUEUED',
          'PROCESSING',
          'SUCCEEDED',
          'FAILED',
          'RETRY_SCHEDULED',
          'CANCEL_REQUESTED',
          'CANCELLED',
          'DEAD_LETTERED',
        ];

        allStates.forEach((target) => {
          if (terminal !== target) {
            expect(canTransition(terminal, target)).toBe(false);
          }
        });
      });
    });
  });

  describe('getValidTransitions', () => {
    it('should return correct transitions for CREATED', () => {
      const transitions = getValidTransitions('CREATED');
      expect(transitions).toContain('QUEUED');
      expect(transitions).toHaveLength(1);
    });

    it('should return correct transitions for QUEUED', () => {
      const transitions = getValidTransitions('QUEUED');
      expect(transitions).toContain('PROCESSING');
      expect(transitions).toContain('CANCELLED');
      expect(transitions.length).toBeGreaterThanOrEqual(2);
    });

    it('should return correct transitions for PROCESSING', () => {
      const transitions = getValidTransitions('PROCESSING');
      expect(transitions).toContain('SUCCEEDED');
      expect(transitions).toContain('FAILED');
      expect(transitions).toContain('CANCEL_REQUESTED');
      expect(transitions.length).toBeGreaterThanOrEqual(3);
    });

    it('should return empty array for terminal states', () => {
      expect(getValidTransitions('SUCCEEDED')).toEqual([]);
      expect(getValidTransitions('CANCELLED')).toEqual([]);
      expect(getValidTransitions('DEAD_LETTERED')).toEqual([]);
    });

    it('should return correct transitions for FAILED', () => {
      const transitions = getValidTransitions('FAILED');
      expect(transitions).toContain('RETRY_SCHEDULED');
      expect(transitions).toContain('DEAD_LETTERED');
      expect(transitions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle same-state transition', () => {
      expect(canTransition('QUEUED', 'QUEUED')).toBe(false);
    });

    it('should handle null/undefined gracefully', () => {
      expect(canTransition(null as any, 'QUEUED')).toBe(false);
      expect(canTransition('QUEUED', null as any)).toBe(false);
    });

    it('should handle invalid status strings', () => {
      expect(canTransition('INVALID' as any, 'QUEUED')).toBe(false);
      expect(canTransition('QUEUED', 'INVALID' as any)).toBe(false);
    });
  });

  describe('Retry Logic', () => {
    it('should support retry cycle: FAILED -> RETRY_SCHEDULED -> QUEUED -> PROCESSING', () => {
      expect(canTransition('FAILED', 'RETRY_SCHEDULED')).toBe(true);
      expect(canTransition('RETRY_SCHEDULED', 'QUEUED')).toBe(true);
      expect(canTransition('QUEUED', 'PROCESSING')).toBe(true);
    });

    it('should prevent infinite retries via DEAD_LETTERED', () => {
      expect(canTransition('FAILED', 'DEAD_LETTERED')).toBe(true);
      expect(canTransition('DEAD_LETTERED', 'RETRY_SCHEDULED')).toBe(false);
    });
  });

  describe('Cancellation Logic', () => {
    it('should support immediate cancellation from QUEUED', () => {
      expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    });

    it('should support cooperative cancellation from PROCESSING', () => {
      expect(canTransition('PROCESSING', 'CANCEL_REQUESTED')).toBe(true);
      expect(canTransition('CANCEL_REQUESTED', 'CANCELLED')).toBe(true);
    });

    it('should handle race between cancellation and completion', () => {
      expect(canTransition('CANCEL_REQUESTED', 'SUCCEEDED')).toBe(true);
      expect(canTransition('CANCEL_REQUESTED', 'FAILED')).toBe(true);
    });
  });
});
