# Security Audit Report

**Project**: Resilient TaskFlow  
**Audit Date**: 2026-08-23  
**Auditor**: Security Review Team  
**Scope**: Authentication, Authorization, Input Validation, Injection Risks, Secrets Management, Dependencies

## Executive Summary

This security audit identifies **critical vulnerabilities** that must be addressed before production deployment, along with recommendations for secure implementation.

### Severity Levels

- 🔴 **CRITICAL**: Immediate security risk, must fix before production
- 🟠 **HIGH**: Significant security concern, fix before production
- 🟡 **MEDIUM**: Security weakness, should fix soon
- 🟢 **LOW**: Minor security improvement
- ℹ️ **INFO**: Security best practice recommendation

### Overall Risk Assessment

| Category           | Risk Level  | Issues Found                |
| ------------------ | ----------- | --------------------------- |
| Authentication     | 🔴 CRITICAL | 3 critical, 2 high          |
| Authorization      | 🟠 HIGH     | 2 high, 1 medium            |
| Input Validation   | 🟡 MEDIUM   | 1 medium, 2 low             |
| Injection Attacks  | 🟢 LOW      | 0 critical (well protected) |
| Secrets Management | 🟠 HIGH     | 2 high, 1 medium            |
| Dependencies       | 🟡 MEDIUM   | Check npm audit             |

**Recommendation**: **DO NOT deploy to production** until critical and high-severity issues are resolved.

---

## 1. Authentication Security

### 🔴 CRITICAL: Hardcoded Test API Keys

**Location**: `apps/api/src/middleware/auth.ts:89-104`

**Issue**:

```typescript
async function validateApiKey(
  apiKey: string
): Promise<AuthenticatedUser | null> {
  // Hardcoded test keys - SECURITY RISK!
  if (apiKey === 'test-api-key') {
    return { id: 'test-user-id', email: 'test@example.com', role: 'user' };
  }
  if (apiKey === 'admin-api-key') {
    return { id: 'admin-user-id', email: 'admin@example.com', role: 'admin' };
  }
  return null;
}
```

**Risk**: Anyone can authenticate as admin with `admin-api-key`.

**Recommendation**:

```typescript
import { getDb } from '@taskflow/database';
import crypto from 'crypto';

async function validateApiKey(
  apiKey: string
): Promise<AuthenticatedUser | null> {
  // Hash the API key
  const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');

  // Look up in database
  const apiKeyRecord = await getDb()
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.hashedKey, hashedKey),
        eq(apiKeys.isActive, true),
        gt(apiKeys.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!apiKeyRecord || apiKeyRecord.length === 0) {
    return null;
  }

  const keyData = apiKeyRecord[0];

  // Update last used timestamp
  await getDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, keyData.id));

  // Get user
  const user = await getDb()
    .select()
    .from(users)
    .where(eq(users.id, keyData.userId))
    .limit(1);

  return user[0]
    ? {
        id: user[0].id,
        email: user[0].email,
        role: user[0].role,
      }
    : null;
}
```

**Action Items**:

1. ✅ Create `api_keys` table in database
2. ✅ Implement API key generation with secure random tokens
3. ✅ Store only hashed keys (SHA-256) in database
4. ✅ Add expiration dates for API keys
5. ✅ Add rate limiting per API key
6. ✅ Remove hardcoded test keys

---

### 🔴 CRITICAL: No JWT Token Validation

**Location**: `apps/api/src/middleware/auth.ts:115-128`

**Issue**:

```typescript
async function validateJwtToken(
  token: string
): Promise<AuthenticatedUser | null> {
  // NO ACTUAL VALIDATION!
  if (token === 'valid-jwt-token') {
    return { id: 'jwt-user-id', email: 'jwt@example.com', role: 'user' };
  }
  return null;
}
```

**Risk**: JWT tokens are not validated. Anyone can create a fake token.

**Recommendation**:

```typescript
import * as jose from 'jose';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'taskflow-api';
const JWT_ISSUER = process.env.JWT_ISSUER || 'taskflow-auth';

async function validateJwtToken(
  token: string
): Promise<AuthenticatedUser | null> {
  try {
    // Import secret key
    const secret = new TextEncoder().encode(JWT_SECRET);

    // Verify token
    const { payload } = await jose.jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      maxTokenAge: '24h', // Tokens expire after 24 hours
    });

    // Extract claims
    const userId = payload.sub as string;
    const email = payload.email as string;
    const role = payload.role as 'admin' | 'user';

    // Validate required claims
    if (!userId || !email || !role) {
      throw new Error('Invalid token claims');
    }

    // Optional: Check if user still exists and is active
    const user = await getDb()
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.isActive, true)))
      .limit(1);

    if (!user || user.length === 0) {
      return null;
    }

    return { id: userId, email, role };
  } catch (error) {
    logger.warn('JWT validation failed', { error });
    return null;
  }
}
```

**Action Items**:

1. ✅ Install `jose` library for JWT validation
2. ✅ Generate and store JWT_SECRET securely
3. ✅ Implement proper JWT validation with signature check
4. ✅ Set appropriate expiration times
5. ✅ Include necessary claims (sub, email, role)
6. ✅ Implement token refresh mechanism

---

### 🔴 CRITICAL: No Password Hashing Implementation

**Location**: Missing `users` table and password handling

**Issue**: No user registration or password authentication implemented.

**Recommendation**:

```typescript
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12; // Higher = more secure, slower

/**
 * Hash password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  // Validate password strength
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters');
  }

  // Check for common patterns
  if (/^(.)\1+$/.test(password)) {
    throw new Error('Password too simple');
  }

  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify password against hash
 */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Register new user
 */
export async function registerUser(
  email: string,
  password: string,
  role: 'user' | 'admin' = 'user'
): Promise<User> {
  // Hash password
  const passwordHash = await hashPassword(password);

  // Create user
  const user = await getDb()
    .insert(users)
    .values({
      email,
      passwordHash,
      role,
      isActive: true,
      createdAt: new Date(),
    })
    .returning();

  return user[0];
}

/**
 * Login user
 */
export async function loginUser(
  email: string,
  password: string
): Promise<{ user: User; token: string } | null> {
  // Find user
  const userRecord = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.isActive, true)))
    .limit(1);

  if (!userRecord || userRecord.length === 0) {
    // Timing-safe comparison (prevent user enumeration)
    await bcrypt.hash(password, SALT_ROUNDS);
    return null;
  }

  const user = userRecord[0];

  // Verify password
  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    return null;
  }

  // Generate JWT token
  const token = await generateJwtToken(user);

  return { user, token };
}
```

**Action Items**:

1. ✅ Install `bcrypt` library
2. ✅ Add `passwordHash` column to `users` table
3. ✅ Implement user registration endpoint
4. ✅ Implement login endpoint
5. ✅ Enforce strong password requirements (12+ chars, complexity)
6. ✅ Implement account lockout after failed attempts
7. ✅ Add email verification for new accounts

---

### 🟠 HIGH: No Rate Limiting on Authentication Endpoints

**Location**: Authentication endpoints not protected

**Issue**: No rate limiting on login/auth endpoints allows brute force attacks.

**Recommendation**:

```typescript
// Strict rate limit for auth endpoints
const authRateLimiter = createRateLimiter({
  maxRequests: 5, // Only 5 attempts
  windowSeconds: 300, // Per 5 minutes
  keyExtractor: (request) => {
    // Rate limit by IP + email/username
    const email = request.body?.email || 'unknown';
    return `auth:${extractIpAddress(request)}:${email}`;
  },
});

// Apply to auth routes
app.post('/auth/login', { preHandler: [authRateLimiter] }, loginHandler);
app.post('/auth/register', { preHandler: [authRateLimiter] }, registerHandler);
```

**Action Items**:

1. ✅ Apply strict rate limiting to auth endpoints (5 attempts per 5 minutes)
2. ✅ Implement account lockout after repeated failures
3. ✅ Add CAPTCHA after 3 failed attempts
4. ✅ Log suspicious authentication attempts
5. ✅ Alert on credential stuffing patterns

---

### 🟠 HIGH: Session Management Missing

**Location**: No session management implemented

**Issue**: No session tracking, can't revoke tokens, no "logout" functionality.

**Recommendation**:

```typescript
/**
 * Session management with Redis
 */
export class SessionManager {
  private redis: Redis;
  private sessionTTL: number = 86400; // 24 hours

  async createSession(userId: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const sessionKey = `session:${sessionId}`;

    await this.redis.setex(
      sessionKey,
      this.sessionTTL,
      JSON.stringify({ userId, createdAt: Date.now() })
    );

    return sessionId;
  }

  async getSession(sessionId: string): Promise<{ userId: string } | null> {
    const sessionKey = `session:${sessionId}`;
    const data = await this.redis.get(sessionKey);

    if (!data) return null;

    return JSON.parse(data);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const sessionKey = `session:${sessionId}`;
    await this.redis.del(sessionKey);
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    // Scan for user sessions
    const pattern = `session:*`;
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      );
      cursor = nextCursor;

      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          const session = JSON.parse(data);
          if (session.userId === userId) {
            await this.redis.del(key);
          }
        }
      }
    } while (cursor !== '0');
  }
}
```

**Action Items**:

1. ✅ Implement session storage in Redis
2. ✅ Add session ID to JWT tokens
3. ✅ Implement logout endpoint (revoke session)
4. ✅ Implement "logout all devices" functionality
5. ✅ Set appropriate session timeouts
6. ✅ Implement session renewal on activity

---

## 2. Authorization Security

### 🟠 HIGH: No Resource Ownership Checks

**Location**: `apps/api/src/routes/jobs.ts` (all endpoints)

**Issue**: Users can access/modify jobs owned by other users.

Example:

```typescript
// GET /api/jobs/:jobId
// No check if job belongs to requesting user!
app.get('/:jobId', async (request, reply) => {
  const job = await getJobById(jobId);
  return job; // Returns ANY job, regardless of owner!
});
```

**Recommendation**:

```typescript
app.get<{ Params: { jobId: string } }>(
  '/:jobId',
  { preHandler: [authenticate] },
  async (request, reply) => {
    const { jobId } = request.params;
    const userId = request.user!.id;
    const userRole = request.user!.role;

    // Get job
    const job = await getJobById(jobId);

    if (!job) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Job not found',
      });
    }

    // Authorization check: Admin can see all, users only their own
    if (userRole !== 'admin' && job.userId !== userId) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have permission to access this job',
      });
    }

    return job;
  }
);
```

**Action Items**:

1. ✅ Add ownership checks to ALL job endpoints (GET, DELETE, CANCEL)
2. ✅ Add ownership checks to queue endpoints
3. ✅ Admins can see all resources, users only their own
4. ✅ Log unauthorized access attempts
5. ✅ Return 403 (Forbidden) not 404 for unauthorized access

---

### 🟠 HIGH: Role-Based Access Control Incomplete

**Location**: `apps/api/src/middleware/auth.ts:154-171`

**Issue**: Only `requireAdmin` implemented, no fine-grained permissions.

**Recommendation**:

```typescript
/**
 * Permission-based authorization
 */
export enum Permission {
  // Job permissions
  JOB_CREATE = 'job:create',
  JOB_READ_OWN = 'job:read:own',
  JOB_READ_ALL = 'job:read:all',
  JOB_UPDATE_OWN = 'job:update:own',
  JOB_UPDATE_ALL = 'job:update:all',
  JOB_DELETE_OWN = 'job:delete:own',
  JOB_DELETE_ALL = 'job:delete:all',

  // Queue permissions
  QUEUE_CREATE = 'queue:create',
  QUEUE_READ = 'queue:read',
  QUEUE_UPDATE = 'queue:update',
  QUEUE_DELETE = 'queue:delete',

  // Worker permissions
  WORKER_READ = 'worker:read',
  WORKER_MANAGE = 'worker:manage',

  // Admin permissions
  ADMIN_ALL = 'admin:all',
}

// Role → Permission mapping
const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [Permission.ADMIN_ALL], // Admin has all permissions
  user: [
    Permission.JOB_CREATE,
    Permission.JOB_READ_OWN,
    Permission.JOB_UPDATE_OWN,
    Permission.JOB_DELETE_OWN,
    Permission.QUEUE_READ,
    Permission.WORKER_READ,
  ],
  readonly: [
    Permission.JOB_READ_OWN,
    Permission.QUEUE_READ,
    Permission.WORKER_READ,
  ],
};

/**
 * Check if user has permission
 */
export function hasPermission(
  user: AuthenticatedUser,
  permission: Permission
): boolean {
  const permissions = ROLE_PERMISSIONS[user.role] || [];

  // Admin has all permissions
  if (permissions.includes(Permission.ADMIN_ALL)) {
    return true;
  }

  return permissions.includes(permission);
}

/**
 * Require specific permission middleware
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    if (!hasPermission(request.user, permission)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: `Permission ${permission} required`,
      });
    }
  };
}

// Usage
app.delete(
  '/:jobId',
  { preHandler: [authenticate, requirePermission(Permission.JOB_DELETE_OWN)] },
  async (request, reply) => {
    // Handler code...
  }
);
```

**Action Items**:

1. ✅ Define granular permissions
2. ✅ Implement role → permission mapping
3. ✅ Add `requirePermission` middleware
4. ✅ Apply permissions to all endpoints
5. ✅ Store permissions in database for flexibility
6. ✅ Implement permission caching

---

### 🟡 MEDIUM: No Audit Logging for Security Events

**Location**: Missing audit log implementation

**Issue**: No logging of security-relevant events (login, logout, access denials).

**Recommendation**:

```typescript
/**
 * Audit logger for security events
 */
export class AuditLogger {
  async logEvent(event: {
    type: 'AUTH' | 'ACCESS' | 'DATA' | 'ADMIN';
    action: string;
    userId?: string;
    resourceId?: string;
    resourceType?: string;
    ipAddress?: string;
    userAgent?: string;
    success: boolean;
    reason?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    await getDb()
      .insert(auditLogs)
      .values({
        ...event,
        timestamp: new Date(),
      });

    // Also log to file for compliance
    logger.security(event.type, {
      action: event.action,
      userId: event.userId,
      success: event.success,
      reason: event.reason,
    });
  }
}

// Usage
auditLogger.logEvent({
  type: 'AUTH',
  action: 'LOGIN_SUCCESS',
  userId: user.id,
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
  success: true,
});

auditLogger.logEvent({
  type: 'ACCESS',
  action: 'JOB_ACCESS_DENIED',
  userId: user.id,
  resourceId: jobId,
  resourceType: 'job',
  success: false,
  reason: 'Not owner',
});
```

**Action Items**:

1. ✅ Create `audit_logs` table
2. ✅ Log all authentication events (login, logout, failed attempts)
3. ✅ Log all authorization failures (403 errors)
4. ✅ Log sensitive data access (job details, user info)
5. ✅ Log admin actions
6. ✅ Implement log retention policy (90 days)
7. ✅ Set up alerts for suspicious patterns

---

## 3. Input Validation

### 🟡 MEDIUM: Incomplete Zod Validation

**Location**: `packages/types/src/index.ts`

**Issue**: Some fields lack proper validation constraints.

**Recommendation**:

```typescript
import { z } from 'zod';

export const submitJobSchema = z.object({
  type: z
    .string()
    .min(1, 'Job type required')
    .max(255, 'Job type too long')
    .regex(
      /^[a-z0-9-]+$/,
      'Job type must be lowercase alphanumeric with dashes'
    ),

  payload: z.record(z.any()).refine(
    (data) => JSON.stringify(data).length <= 1000000, // 1MB limit
    'Payload too large (max 1MB)'
  ),

  queue: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional()
    .default('default'),

  priority: z
    .enum(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'])
    .optional()
    .default('NORMAL'),

  maxAttempts: z
    .number()
    .int()
    .min(0, 'Max attempts must be non-negative')
    .max(10, 'Max attempts cannot exceed 10')
    .optional(),

  timeoutMs: z
    .number()
    .int()
    .min(1000, 'Timeout must be at least 1 second')
    .max(300000, 'Timeout cannot exceed 5 minutes')
    .optional(),

  scheduledAt: z
    .string()
    .datetime()
    .optional()
    .refine(
      (date) => !date || new Date(date) > new Date(),
      'Scheduled time must be in the future'
    ),

  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9-_]+$/, 'Invalid idempotency key format')
    .optional(),

  metadata: z.record(z.any()).optional(),

  tags: z
    .array(z.string().max(50))
    .max(10, 'Maximum 10 tags allowed')
    .optional(),
});
```

**Action Items**:

1. ✅ Add length limits to all string fields
2. ✅ Add regex validation for format constraints
3. ✅ Add range validation for numeric fields
4. ✅ Add size limits for payload (prevent DoS)
5. ✅ Validate date/time formats
6. ✅ Sanitize HTML if accepting rich text

---

### 🟢 LOW: Missing Request Size Limits

**Location**: Fastify configuration

**Issue**: No global request size limits configured.

**Recommendation**:

```typescript
const app = fastify({
  logger: true,

  // Security settings
  bodyLimit: 1048576, // 1MB max request body
  maxParamLength: 500, // Max URL parameter length

  // Prevent parameter pollution
  querystringParser: (str) => {
    return querystring.parse(str, '&', '=', { maxKeys: 100 });
  },
});

// Add helmet for security headers
await app.register(require('@fastify/helmet'), {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
});

// Add CORS
await app.register(require('@fastify/cors'), {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
});
```

**Action Items**:

1. ✅ Set request body size limit (1MB)
2. ✅ Set URL parameter length limit
3. ✅ Install and configure @fastify/helmet
4. ✅ Configure CORS properly
5. ✅ Add CSP headers
6. ✅ Enable HSTS

---

## 4. Injection Attack Protection

### ✅ GOOD: SQL Injection Protected

**Status**: Well protected by Drizzle ORM

**Evidence**:

```typescript
// Drizzle uses parameterized queries automatically
const jobs = await db.select().from(jobs).where(eq(jobs.userId, userId)); // Parameterized, safe!
```

**No action needed** - Continue using Drizzle ORM for all database queries.

---

### ✅ GOOD: NoSQL Injection Protected

**Status**: Redis commands are parameterized

**Evidence**:

```typescript
// IORedis parameterizes commands
await redis.get(key); // Safe
await redis.set(key, value); // Safe
```

**Recommendation**: Never use `eval()` with user input without sanitization.

---

### ℹ️ INFO: Command Injection Risk

**Location**: Worker job handlers

**Issue**: If job handlers execute shell commands with user-provided data.

**Recommendation**:

```typescript
// ❌ NEVER DO THIS
const result = exec(`process-file ${job.payload.filename}`);

// ✅ DO THIS INSTEAD
import { spawn } from 'child_process';

const result = spawn('process-file', [job.payload.filename], {
  shell: false, // Prevent shell expansion
  timeout: 30000,
});
```

**Action Items**:

1. ✅ Never use `exec()` with user input
2. ✅ Use `spawn()` with `shell: false`
3. ✅ Whitelist allowed commands
4. ✅ Validate and sanitize all user input
5. ✅ Run workers with minimal privileges

---

## 5. Secrets Management

### 🟠 HIGH: Secrets in Environment Variables

**Location**: `.env` file (not in repo, but commonly leaked)

**Issue**: Secrets stored in plain text in `.env` files.

**Recommendation**:

```typescript
// Use a secrets manager in production
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

class SecretsManager {
  private client: SecretsManagerClient;
  private cache: Map<string, { value: string; expiresAt: number }> = new Map();

  async getSecret(secretName: string): Promise<string> {
    // Check cache
    const cached = this.cache.get(secretName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Fetch from AWS Secrets Manager
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await this.client.send(command);
    const secret = response.SecretString!;

    // Cache for 5 minutes
    this.cache.set(secretName, {
      value: secret,
      expiresAt: Date.now() + 300000,
    });

    return secret;
  }
}

// Usage
const dbPassword = await secretsManager.getSecret('prod/db/password');
const jwtSecret = await secretsManager.getSecret('prod/jwt/secret');
```

**Action Items**:

1. ✅ Use AWS Secrets Manager, HashiCorp Vault, or similar
2. ✅ Rotate secrets regularly (every 90 days)
3. ✅ Never commit `.env` files to git
4. ✅ Use different secrets for each environment
5. ✅ Encrypt secrets at rest
6. ✅ Audit secret access
7. ✅ Implement secret rotation without downtime

---

### 🟠 HIGH: API Keys Stored in Plain Text

**Location**: Database (if implemented as recommended)

**Issue**: API keys must be hashed, never stored plain text.

**Recommendation**:

```typescript
import crypto from 'crypto';

/**
 * Generate API key
 */
export function generateApiKey(): { key: string; hash: string } {
  // Generate random key (32 bytes = 256 bits)
  const keyBytes = crypto.randomBytes(32);
  const key = keyBytes.toString('base64url'); // URL-safe base64

  // Hash the key for storage
  const hash = crypto.createHash('sha256').update(key).digest('hex');

  return { key, hash };
}

// Usage
const { key, hash } = generateApiKey();

// Store only hash in database
await db.insert(apiKeys).values({
  userId,
  hashedKey: hash, // NEVER store the plain key!
  name: 'Production API Key',
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
  createdAt: new Date(),
});

// Return key to user (ONLY ONCE!)
return {
  apiKey: key,
  message: 'Save this key! It will not be shown again.',
};
```

**Action Items**:

1. ✅ Hash API keys with SHA-256 before storage
2. ✅ Show API key only once at creation
3. ✅ Allow users to revoke keys
4. ✅ Set expiration dates
5. ✅ Implement key rotation

---

### 🟡 MEDIUM: No Secret Rotation Policy

**Location**: N/A (missing)

**Issue**: No process for rotating secrets.

**Recommendation**:
Create a secret rotation schedule:

| Secret            | Rotation Frequency | Process                                            |
| ----------------- | ------------------ | -------------------------------------------------- |
| JWT Secret        | 90 days            | Generate new, support both for 24h, deprecate old  |
| Database Password | 90 days            | Update connection pool, no downtime                |
| API Keys          | User-initiated     | User generates new, old expires after grace period |
| Redis Password    | 180 days           | Update configuration, rolling restart              |

**Action Items**:

1. ✅ Document secret rotation procedures
2. ✅ Implement zero-downtime rotation
3. ✅ Set up automated rotation reminders
4. ✅ Test rotation procedures regularly
5. ✅ Audit who has access to secrets

---

## 6. Dependency Security

### 🟡 MEDIUM: Dependency Vulnerabilities

**Action**: Run `npm audit` regularly

```bash
# Check for vulnerabilities
npm audit

# Fix automatically if possible
npm audit fix

# Force fix (may break things)
npm audit fix --force
```

**Recommendation**:

1. ✅ Run `npm audit` in CI/CD pipeline
2. ✅ Set up Dependabot for automated updates
3. ✅ Use `npm-check-updates` to keep dependencies current
4. ✅ Review and test updates before merging
5. ✅ Pin exact versions in `package-lock.json`
6. ✅ Use `npx depcheck` to remove unused dependencies

**CI/CD Integration**:

```yaml
# .github/workflows/security.yml
name: Security Scan

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 0 * * 0' # Weekly

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npx depcheck
```

---

## 7. Security Best Practices

### Transport Security

✅ **HTTPS Only**:

```typescript
if (process.env.NODE_ENV === 'production') {
  app.addHook('onRequest', (request, reply, done) => {
    if (!request.headers['x-forwarded-proto']?.includes('https')) {
      return reply.redirect(301, `https://${request.hostname}${request.url}`);
    }
    done();
  });
}
```

✅ **Security Headers**:

```typescript
app.register(helmet, {
  contentSecurityPolicy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
});
```

### Error Handling

❌ **Don't expose stack traces in production**:

```typescript
app.setErrorHandler((error, request, reply) => {
  logger.error('Request error', { error, requestId: request.id });

  const isDev = process.env.NODE_ENV === 'development';

  reply.status(error.statusCode || 500).send({
    error: 'Internal Server Error',
    message: isDev ? error.message : 'An error occurred',
    ...(isDev && { stack: error.stack }), // Only in development
  });
});
```

### Rate Limiting

✅ **Implement rate limiting on all endpoints**:

```typescript
// Global rate limit
app.register(rateLimiter, {
  max: 100,
  timeWindow: '15 minutes',
});

// Stricter for auth endpoints
app.register(rateLimiter, {
  prefix: '/auth',
  max: 5,
  timeWindow: '5 minutes',
});
```

### Logging

✅ **Log security events but sanitize sensitive data**:

```typescript
// ❌ Don't log sensitive data
logger.info('User login', { email, password }); // NEVER!

// ✅ Log safely
logger.info('User login', {
  email,
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});
```

---

## Summary and Action Plan

### Immediate Actions (Before Production)

**CRITICAL (Must Fix)**:

1. [ ] Remove hardcoded API keys
2. [ ] Implement proper JWT validation
3. [ ] Implement password hashing (bcrypt)
4. [ ] Add resource ownership checks to all endpoints

**HIGH (Should Fix)**: 5. [ ] Implement API key storage (hashed) 6. [ ] Add rate limiting to auth endpoints 7. [ ] Implement session management 8. [ ] Add role-based permissions 9. [ ] Use secrets manager for production

### Short-term Actions (1-2 weeks)

**MEDIUM**: 10. [ ] Implement audit logging 11. [ ] Strengthen input validation 12. [ ] Add security headers (helmet) 13. [ ] Implement secret rotation

### Ongoing Actions

**MAINTENANCE**: 14. [ ] Run `npm audit` weekly 15. [ ] Update dependencies monthly 16. [ ] Review audit logs weekly 17. [ ] Rotate secrets every 90 days 18. [ ] Conduct security reviews quarterly

---

## Security Checklist

Before production deployment:

- [ ] All CRITICAL issues resolved
- [ ] All HIGH issues resolved
- [ ] Authentication properly implemented
- [ ] Authorization checks on all endpoints
- [ ] Input validation comprehensive
- [ ] Secrets stored securely (not in .env)
- [ ] HTTPS enforced
- [ ] Security headers configured
- [ ] Rate limiting enabled
- [ ] Audit logging implemented
- [ ] Error messages don't expose internals
- [ ] Dependencies up to date
- [ ] npm audit shows no high/critical vulnerabilities
- [ ] Penetration testing completed
- [ ] Security incident response plan documented

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Fastify Security](https://www.fastify.io/docs/latest/Reference/Security/)
- [JWT Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)

---

**Next Steps**: Address CRITICAL and HIGH severity issues before proceeding with production deployment.
