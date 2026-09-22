import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  listOperationalAudit: vi.fn(),
}));

vi.mock('@taskflow/database', () => database);

import { errorHandler } from '../middleware/error-handler';
import { auditRoutes } from '../routes/audit';

const userId = '10000000-0000-4000-8000-000000000001';
const otherUserId = '10000000-0000-4000-8000-000000000002';
const apps: FastifyInstance[] = [];

async function createAuditApp(
  role: 'admin' | 'user'
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', (request, _reply, done) => {
    request.user = { id: userId, email: 'actor@example.test', role };
    done();
  });
  await app.register(auditRoutes, { prefix: '/audit' });
  apps.push(app);
  return app;
}

beforeEach(() => {
  database.listOperationalAudit.mockResolvedValue({ records: [], total: 0 });
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('operational audit reads', () => {
  it('forces ordinary users into their own actor scope', async () => {
    const app = await createAuditApp('user');
    const response = await app.inject({
      method: 'GET',
      url: '/audit?action=job.manual_retry&outcome=SUCCEEDED&limit=5&offset=2',
    });

    expect(response.statusCode).toBe(200);
    expect(database.listOperationalAudit).toHaveBeenCalledWith({
      actorUserId: userId,
      action: 'job.manual_retry',
      outcome: 'SUCCEEDED',
      limit: 5,
      offset: 2,
    });
  });

  it('rejects cross-actor user reads before querying PostgreSQL', async () => {
    const app = await createAuditApp('user');
    const response = await app.inject({
      method: 'GET',
      url: `/audit?actorUserId=${otherUserId}`,
    });

    expect(response.statusCode).toBe(403);
    expect(database.listOperationalAudit).not.toHaveBeenCalled();
  });

  it('allows an administrator to paginate a selected actor', async () => {
    const app = await createAuditApp('admin');
    const response = await app.inject({
      method: 'GET',
      url: `/audit?actorUserId=${otherUserId}&limit=1`,
    });

    expect(response.statusCode).toBe(200);
    expect(database.listOperationalAudit).toHaveBeenCalledWith({
      actorUserId: otherUserId,
      action: undefined,
      outcome: undefined,
      limit: 1,
      offset: 0,
    });
  });
});
