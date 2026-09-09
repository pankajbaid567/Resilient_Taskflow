import { securityConfig } from '@taskflow/config';
import { createLogger } from '@taskflow/logger';
import { FastifyReply, FastifyRequest } from 'fastify';
import * as jose from 'jose';


const logger = createLogger({ component: 'AuthMiddleware' });

/**
 * Stable development identities. Local/test database fixtures must create
 * users with these IDs so authenticated job rows satisfy the users FK.
 */
export const TEST_USER_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_ADMIN_USER_ID = '00000000-0000-4000-8000-000000000002';

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
  const apiKey = request.headers['x-api-key'] as string | undefined;
  const authHeader = request.headers.authorization;

  try {
    // Method 1: API Key authentication
    if (apiKey) {
      const user = validateApiKey(apiKey);
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
    logger.warn('Authentication failed', {
      requestId: request.id,
      url: request.url,
      hasApiKey: !!apiKey,
      hasBearer: !!authHeader,
    });

    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
      statusCode: 401,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Authentication error', {
      requestId: request.id,
      error,
    });

    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid authentication credentials',
      statusCode: 401,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Validate API key
 *
 * In development, accepts test keys.
 * In production, validates against database (to be implemented).
 */
function validateApiKey(apiKey: string): AuthenticatedUser | null {
  // Development mode: Accept test keys
  if (process.env.NODE_ENV !== 'production') {
    if (apiKey === 'test-api-key') {
      logger.debug('Using development test API key');
      return {
        id: TEST_USER_ID,
        email: 'test@example.com',
        role: 'user',
      };
    }

    if (apiKey === 'admin-api-key') {
      logger.debug('Using development admin API key');
      return {
        id: TEST_ADMIN_USER_ID,
        email: 'admin@example.com',
        role: 'admin',
      };
    }
  }

  // Production mode: Validate against database
  // TODO: Implement database lookup
  // const hashedKey = await hashApiKey(apiKey, securityConfig.apiKeyHashSalt);
  // const keyRecord = await db.query.apiKeys.findFirst({
  //   where: eq(apiKeys.keyHash, hashedKey),
  //   with: { user: true },
  // });
  //
  // if (!keyRecord || keyRecord.expiresAt < new Date()) {
  //   return null;
  // }
  //
  // return {
  //   id: keyRecord.userId,
  //   email: keyRecord.user.email,
  //   role: keyRecord.user.role,
  // };

  logger.warn('API key validation not implemented for production', {
    hint: 'Use JWT tokens or implement database-backed API keys',
  });

  return null;
}

/**
 * Validate JWT token
 *
 * Verifies JWT signature, expiration, and extracts user claims.
 */
async function validateJwtToken(
  token: string
): Promise<AuthenticatedUser | null> {
  try {
    // Create secret key from environment
    const secret = new TextEncoder().encode(securityConfig.jwtSecret);

    // Verify and decode JWT
    const { payload } = await jose.jwtVerify(token, secret, {
      issuer: 'taskflow-api',
      audience: 'taskflow-clients',
    });

    // Extract user claims
    if (
      !payload.sub ||
      typeof payload.email !== 'string' ||
      (payload.role !== 'admin' && payload.role !== 'user')
    ) {
      logger.warn('Invalid JWT payload structure', {
        hasSubject: !!payload.sub,
        hasEmail: !!payload.email,
        role: payload.role,
      });
      return null;
    }

    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  } catch (error) {
    // Log specific JWT errors
    if (error instanceof jose.errors.JWTExpired) {
      logger.debug('JWT token expired');
    } else if (error instanceof jose.errors.JWTInvalid) {
      logger.debug('JWT token invalid');
    } else if (error instanceof jose.errors.JWSSignatureVerificationFailed) {
      logger.warn('JWT signature verification failed');
    } else {
      logger.error('JWT validation error', { error });
    }

    return null;
  }
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
  const apiKey = request.headers['x-api-key'] as string | undefined;
  const authHeader = request.headers.authorization;

  try {
    if (apiKey) {
      const user = validateApiKey(apiKey);
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
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
      statusCode: 401,
      timestamp: new Date().toISOString(),
    });
  }

  if (request.user.role !== 'admin') {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Admin access required',
      statusCode: 403,
      timestamp: new Date().toISOString(),
    });
  }
}
