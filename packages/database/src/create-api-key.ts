import './quiet-logs';
import { randomBytes } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';

import { eq } from 'drizzle-orm';

import { closeConnection, db } from './client';
import { hashApiKey } from './repositories/auth.repository';
import { apiKeys, users } from './schema';

/**
 * Provision a user (if missing) and issue a new API key.
 *
 * Usage: pnpm db:create-api-key -- --email admin@local --role admin \
 *          [--name dev] [--out path/to/file]
 *
 * The plaintext key is shown exactly once; only its HMAC fingerprint is
 * stored. There is intentionally no way to recover a lost key.
 *
 * Without --out the key is printed to stdout. With --out it is written to that
 * file (mode 0600) and NOT printed; an existing file is never overwritten.
 * Use --out for secrets that a service reads from a file, such as the
 * Prometheus scrape credential.
 */
function parseArgs(argv: string[]): {
  email: string;
  role: 'admin' | 'user';
  name: string;
  out: string | undefined;
} {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    // A bare `--` is the package manager's argument separator, not a flag.
    if (flag === '--') continue;
    if (flag?.startsWith('--')) {
      args.set(flag.slice(2), argv[i + 1] ?? '');
      i += 1;
    }
  }

  const email = args.get('email') ?? 'admin@taskflow.local';
  const role = args.get('role') ?? 'admin';
  if (role !== 'admin' && role !== 'user') {
    throw new Error('--role must be "admin" or "user"');
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new Error('--email must be a valid email address');
  }

  const out = args.get('out');
  if (out !== undefined && out.trim() === '') {
    throw new Error('--out needs a file path');
  }
  return { email, role, name: args.get('name') ?? 'cli', out };
}

async function createApiKey(): Promise<void> {
  try {
    const { email, role, name, out } = parseArgs(process.argv.slice(2));

    let [user] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      [user] = await db
        .insert(users)
        .values({
          email,
          role,
          // API-key-only principal: no password login exists.
          passwordHash: '!disabled',
        })
        .returning({ id: users.id, role: users.role });
    }

    if (!user) throw new Error('Could not create or load user');

    const plaintext = `tf_${randomBytes(24).toString('base64url')}`;

    // Write the file first: 'wx' fails if it already exists, so a mistaken path
    // aborts before any key is stored. It is removed again if the insert fails,
    // so a file never holds a key that does not work.
    if (out !== undefined) {
      writeFileSync(out, `${plaintext}\n`, { flag: 'wx', mode: 0o600 });
    }
    try {
      await db.insert(apiKeys).values({
        userId: user.id,
        name,
        keyHash: hashApiKey(plaintext),
      });
    } catch (error) {
      if (out !== undefined) unlinkSync(out);
      throw error;
    }

    if (out === undefined) {
      // stdout is reserved for the key so it can be captured by scripts.
      process.stdout.write(`${plaintext}\n`);
    }
    process.stderr.write(
      `API key created for ${email} (role ${user.role}, name ${name})` +
        (out !== undefined ? `; written to ${out}\n` : '\n')
    );
  } catch (error) {
    process.stderr.write(
      `API key creation failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    await closeConnection();
  }
}

if (require.main === module) {
  void createApiKey();
}
