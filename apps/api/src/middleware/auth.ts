import { securityConfig } from '@taskflow/config';
import { findActiveUserByApiKey, findActiveUserById } from '@taskflow/database';
import { createLogger } from '@taskflow/logger';
import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import * as jose from 'jose';
import { z } from 'zod';

const logger = createLogger({ component: 'AuthMiddleware' });

const userIdSchema = z.string().uuid();

/**
 * User context attached to request after authentication
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

/**
 * Extend Fastify request to include user
 */
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Authentication Middleware
 *
 * Validates API key or JWT token and attaches user to request.
 *
 * Supports two authentication methods:
 * 1. API Key: X-API-Key header
 * 2. JWT: Authorization: Bearer <token>
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const rawApiKey = request.headers['x-api-key'];
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey : undefined;
  const authHeader = request.headers.authorization;

  try {
    // Method 1: API Key authentication
    if (apiKey) {
      const user = await validateApiKey(apiKey);
      if (user) {
        request.user = user;
        return;
      }
    }

    // Method 2: JWT authentication
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const user = await validateJwtToken(token);
      if (user) {
        request.user = user;
        return;
      }
    }

    // No valid authentication provided
    logger.warn(
      {
        requestId: request.id,
        url: request.url,
        hasApiKey: !!apiKey,
        hasBearer: !!authHeader,
      },
      'Authentication failed'
    );

    void reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
      statusCode: 401,
      timestamp: new Date().toISOString(),
    });
    return;
  } catch (error) {
    logger.error(
      {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'Authentication backend unavailable'
    );

    void reply.status(503).send({
      error: 'Service Unavailable',
      message: 'Authentication service unavailable',
      statusCode: 503,
      timestamp: new Date().toISOString(),
    });
    return;
  }
}

/**
 * Validate API key
 *
 * Every environment uses the same database-backed credential path. Tests and
 * local development must explicitly seed a hashed api_keys row.
 */
async function validateApiKey(
  apiKey: string
): Promise<AuthenticatedUser | null> {
  if (apiKey.length < 1 || apiKey.length > 512) return null;
  return (await findActiveUserByApiKey(apiKey)) ?? null;
}

/**
 * Validate JWT token
 *
 * Verifies JWT signature, expiration, and extracts user claims.
 */
async function validateJwtToken(
  token: string
): Promise<AuthenticatedUser | null> {
  let payload: jose.JWTPayload;
  try {
    const secret = new TextEncoder().encode(securityConfig.jwtSecret);
    ({ payload } = await jose.jwtVerify(token, secret, {
      issuer: 'taskflow-api',
      audience: 'taskflow-clients',
      algorithms: ['HS256'],
    }));
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      logger.debug('JWT token expired');
    } else if (error instanceof jose.errors.JWTInvalid) {
      logger.debug('JWT token invalid');
    } else if (error instanceof jose.errors.JWSSignatureVerificationFailed) {
      logger.warn('JWT signature verification failed');
    } else {
      logger.debug(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'JWT validation failed'
      );
    }

    return null;
  }

  const subject = userIdSchema.safeParse(payload.sub);
  if (!subject.success) {
    logger.warn('JWT subject is not a UUID');
    return null;
  }

  // Role, email, revocation, and activation are current database state. Token
  // copies of those mutable claims are deliberately ignored.
  return (await findActiveUserById(subject.data)) ?? null;
}

/**
 * Generate JWT token for user (utility for testing)
 *
 * @param user User to generate token for
 * @param expiresIn Token expiration time (default: 24h)
 * @returns JWT token string
 */
export async function generateJwtToken(
  user: AuthenticatedUser,
  expiresIn: string = '24h'
): Promise<string> {
  const secret = new TextEncoder().encode(securityConfig.jwtSecret);

  const token = await new jose.SignJWT({
    email: user.email,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('taskflow-api')
    .setAudience('taskflow-clients')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);

  return token;
}

/**
 * Optional authentication middleware
 *
 * Attaches user if authentication is provided, but doesn't require it.
 */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const rawApiKey = request.headers['x-api-key'];
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey : undefined;
  const authHeader = request.headers.authorization;

  try {
    if (apiKey) {
      const user = await validateApiKey(apiKey);
      if (user) {
        request.user = user;
      }
    } else if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const user = await validateJwtToken(token);
      if (user) {
        request.user = user;
      }
    }
  } catch (error) {
    // Silently fail for optional auth
    logger.debug('Optional auth failed', { requestId: request.id, error });
  }
}

/**
 * Require admin role
 */
export function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  if (!request.user) {
    void reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
      statusCode: 401,
      timestamp: new Date().toISOString(),
    });
    done();
    return;
  }

  if (request.user.role !== 'admin') {
    void reply.status(403).send({
      error: 'Forbidden',
      message: 'Admin access required',
      statusCode: 403,
      timestamp: new Date().toISOString(),
    });
    done();
    return;
  }

  done();
}
