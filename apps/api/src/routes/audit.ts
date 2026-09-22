import {
  listOperationalAudit,
  type OperationalAuditLog,
} from '@taskflow/database';
import { AUDIT_ACTION_VALUES, AUDIT_OUTCOME_VALUES } from '@taskflow/types';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const listAuditQuerySchema = z
  .object({
    actorUserId: z.string().uuid().optional(),
    action: z.enum(AUDIT_ACTION_VALUES).optional(),
    outcome: z.enum(AUDIT_OUTCOME_VALUES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

function serializeAudit(
  record: OperationalAuditLog
): Omit<OperationalAuditLog, 'createdAt'> & { createdAt: string } {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Tenant-scoped audit reads; administrators may query across actors. */
export function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      actorUserId?: string;
      action?: string;
      outcome?: string;
      limit?: string | number;
      offset?: string | number;
    };
  }>('/', async (request, reply) => {
    const query = listAuditQuerySchema.parse(request.query);
    const actorUserId =
      request.user!.role === 'admin' ? query.actorUserId : request.user!.id;

    if (
      request.user!.role !== 'admin' &&
      query.actorUserId !== undefined &&
      query.actorUserId !== request.user!.id
    ) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Audit records are scoped to the current user',
        statusCode: 403,
        timestamp: new Date().toISOString(),
      });
    }

    const result = await listOperationalAudit({
      actorUserId,
      action: query.action,
      outcome: query.outcome,
      limit: query.limit,
      offset: query.offset,
    });
    return reply.send({
      data: result.records.map(serializeAudit),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: result.total,
      },
    });
  });

  return Promise.resolve();
}
