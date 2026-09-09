/**
 * @taskflow/database
 * 
 * Database layer with Drizzle ORM, schema definitions, and repositories.
 */

// Client
export {
  db,
  sql,
  testConnection,
  closeConnection,
  transaction,
  initDatabase,
} from './client';

// Schema
export * from './schema';

// State Machine
export {
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  STATE_MACHINE_DIAGRAM,
  isValidTransition,
  isTerminalState,
  getValidTransitions,
  validateTransition,
  InvalidStateTransitionError,
} from './state-machine';

// Repositories
export * from './repositories';
