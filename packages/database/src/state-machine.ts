import { JobStatus } from '@taskflow/types';

/**
 * Job State Machine
 *
 * Defines valid state transitions for job lifecycle.
 * See: docs/architecture/state-machine.md
 */

type ValidTransitions = Record<JobStatus, JobStatus[]>;

/**
 * A job status as either the enum member or its string value. Database rows
 * expose the string-literal form, so both are accepted without casts.
 */
export type JobStatusValue = `${JobStatus}`;

/**
 * Valid State Transitions
 *
 * This table is enforced: every repository function that changes `jobs.status`
 * calls {@link validateTransition} immediately before its UPDATE. It lists
 * exactly the transitions the runtime performs, and no others:
 *
 * - PROCESSING -> QUEUED covers both lease-expiry recovery and the shutdown
 *   release (`releaseJobDelivery`), which hands the job back to the queue.
 * - CANCEL_REQUESTED -> SUCCEEDED is a result that commits before the owner
 *   observed the cancel request (the first durable observation wins).
 * - FAILED is a legacy state. The runtime never writes it: a failed attempt
 *   goes straight to RETRY_SCHEDULED or DEAD_LETTERED. Rows that still hold it
 *   keep their outgoing transitions so they can be resolved.
 */
export const VALID_TRANSITIONS: ValidTransitions = {
  [JobStatus.CREATED]: [JobStatus.QUEUED, JobStatus.CANCELLED],

  [JobStatus.QUEUED]: [JobStatus.PROCESSING, JobStatus.CANCELLED],

  [JobStatus.PROCESSING]: [
    JobStatus.SUCCEEDED,
    JobStatus.RETRY_SCHEDULED,
    JobStatus.DEAD_LETTERED,
    JobStatus.QUEUED,
    JobStatus.CANCEL_REQUESTED,
  ],

  [JobStatus.FAILED]: [JobStatus.RETRY_SCHEDULED, JobStatus.DEAD_LETTERED],

  [JobStatus.RETRY_SCHEDULED]: [JobStatus.QUEUED, JobStatus.CANCELLED],

  [JobStatus.CANCEL_REQUESTED]: [JobStatus.CANCELLED, JobStatus.SUCCEEDED],

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
export function isValidTransition(
  from: JobStatusValue,
  to: JobStatusValue
): boolean {
  return (VALID_TRANSITIONS[from] as readonly JobStatusValue[]).includes(to);
}

/**
 * Check if a state is terminal
 */
export function isTerminalState(status: JobStatusValue): boolean {
  return (TERMINAL_STATES as readonly JobStatusValue[]).includes(status);
}

/**
 * Get valid transitions for a given state
 */
export function getValidTransitions(status: JobStatusValue): JobStatus[] {
  return VALID_TRANSITIONS[status];
}

/**
 * Validate state transition and throw error if invalid
 */
export function validateTransition(
  from: JobStatusValue,
  to: JobStatusValue
): void {
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
  └─→ CANCELLED (terminal)

QUEUED
  ├─→ PROCESSING
  └─→ CANCELLED (terminal)

PROCESSING
  ├─→ SUCCEEDED (terminal)
  ├─→ RETRY_SCHEDULED
  ├─→ DEAD_LETTERED (terminal)
  ├─→ QUEUED            (lease expired, or released on worker shutdown)
  └─→ CANCEL_REQUESTED

RETRY_SCHEDULED
  ├─→ QUEUED
  └─→ CANCELLED (terminal)

CANCEL_REQUESTED
  ├─→ CANCELLED (terminal)
  └─→ SUCCEEDED (terminal; result committed before the request was observed)

FAILED (legacy; never written by the runtime)
  ├─→ RETRY_SCHEDULED
  └─→ DEAD_LETTERED (terminal)

TERMINAL STATES:
  • SUCCEEDED
  • CANCELLED
  • DEAD_LETTERED
`;
