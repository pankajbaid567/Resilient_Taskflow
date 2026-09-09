import type { HandlerRegistry } from '@taskflow/worker';

import { processDataHandler } from './process-data.handler';
import { sendEmailHandler } from './send-email.handler';
import { testIdempotentHandler } from './test-idempotent.handler';

/** Register the handlers supplied by the worker application. */
export function registerHandlers(registry: HandlerRegistry): void {
  registry.register('send-email', sendEmailHandler);
  registry.register('process-data', processDataHandler);

  // This handler writes only to integration-test tables and must never be
  // reachable in a development or production worker.
  if (process.env.NODE_ENV === 'test') {
    registry.register('test-idempotent', testIdempotentHandler);
  }
}
