import { createHmac } from 'node:crypto';

import { securityConfig } from '@taskflow/config';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

import { db } from '../client';
import { apiKeys, users } from '../schema';

export interface ActiveApiPrincipal {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

/** One-way, deployment-keyed fingerprint stored in PostgreSQL. */
export function hashApiKey(
  apiKey: string,
  salt: string = securityConfig.apiKeyHashSalt
): string {
  if (apiKey.length < 1 || apiKey.length > 512) {
    throw new RangeError('API key must contain between 1 and 512 characters');
  }
  if (salt.length < 16) {
    throw new RangeError(
      'API key hash salt must contain at least 16 characters'
    );
  }

  return createHmac('sha256', salt).update(apiKey, 'utf8').digest('hex');
}

export async function findActiveUserByApiKey(
  apiKey: string
): Promise<ActiveApiPrincipal | undefined> {
  const [principal] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(
      and(
        eq(apiKeys.keyHash, hashApiKey(apiKey)),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        eq(users.isActive, true)
      )
    )
    .limit(1);

  return normalizePrincipal(principal);
}

export async function findActiveUserById(
  userId: string
): Promise<ActiveApiPrincipal | undefined> {
  const [principal] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isActive, true)))
    .limit(1);

  return normalizePrincipal(principal);
}

function normalizePrincipal(
  principal: { id: string; email: string; role: string } | undefined
): ActiveApiPrincipal | undefined {
  if (!principal || (principal.role !== 'admin' && principal.role !== 'user')) {
    return undefined;
  }

  return { ...principal, role: principal.role };
}
