import { JobStatus } from '@taskflow/types';

/**
 * Job State Machine
 *
 * Defines valid state transitions for job lifecycle.
 * See: docs/architecture/state-machine.md
 */

type ValidTransitions = Record<JobStatus, JobStatus[]>;

/**
 * Valid State Transitions
 */
export const VALID_TRANSITIONS: ValidTransitions = {
  [JobStatus.CREATED]: [JobStatus.QUEUED, JobStatus.CANCELLED],

  [JobStatus.QUEUED]: [JobStatus.PROCESSING, JobStatus.CANCELLED],

  [JobStatus.PROCESSING]: [
    JobStatus.SUCCEEDED,
    JobStatus.FAILED,
    JobStatus.RETRY_SCHEDULED,
    JobStatus.DEAD_LETTERED,
    JobStatus.CANCEL_REQUESTED,
  ],

  [JobStatus.FAILED]: [JobStatus.RETRY_SCHEDULED, JobStatus.DEAD_LETTERED],

  [JobStatus.RETRY_SCHEDULED]: [JobStatus.QUEUED, JobStatus.CANCELLED],

  [JobStatus.CANCEL_REQUESTED]: [
    JobStatus.CANCELLED,
    JobStatus.SUCCEEDED,
    JobStatus.FAILED,
  ],

  [JobStatus.SUCCEEDED]: [],

  [JobStatus.CANCELLED]: [],

  [JobStatus.DEAD_LETTERED]: [],
};

/**
 * Terminal States (no transitions allowed)
 */
export const TERMINAL_STATES: JobStatus[] = [
  JobStatus.SUCCEEDED,
  JobStatus.CANCELLED,
  JobStatus.DEAD_LETTERED,
];

/**
 * Check if a state transition is valid
 */
export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Check if a state is terminal
 */
export function isTerminalState(status: JobStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Get valid transitions for a given state
 */
export function getValidTransitions(status: JobStatus): JobStatus[] {
  return VALID_TRANSITIONS[status];
}

/**
 * Validate state transition and throw error if invalid
 */
export function validateTransition(from: JobStatus, to: JobStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidStateTransitionError(
      `Invalid state transition from ${from} to ${to}. ` +
        `Valid transitions from ${from}: ${getValidTransitions(from).join(', ')}`
    );
  }
}

/**
 * Custom Error for Invalid State Transitions
 */
export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
    Object.setPrototypeOf(this, InvalidStateTransitionError.prototype);
  }
}

/**
 * State Machine Diagram (for documentation)
 */
export const STATE_MACHINE_DIAGRAM = `
Job State Machine:

CREATED
  ├─→ QUEUED
  └─→ CANCELLED

QUEUED
  ├─→ PROCESSING
  └─→ CANCELLED

PROCESSING
  ├─→ SUCCEEDED (terminal)
  ├─→ FAILED
  ├─→ RETRY_SCHEDULED
  ├─→ DEAD_LETTERED (terminal)
  └─→ CANCEL_REQUESTED

FAILED
  ├─→ RETRY_SCHEDULED
  └─→ DEAD_LETTERED (terminal)

RETRY_SCHEDULED
  ├─→ QUEUED
  └─→ CANCELLED (terminal)

CANCEL_REQUESTED
  ├─→ CANCELLED (terminal)
  ├─→ SUCCEEDED (terminal)
  └─→ FAILED

TERMINAL STATES:
  • SUCCEEDED
  • CANCELLED
  • DEAD_LETTERED
`;
