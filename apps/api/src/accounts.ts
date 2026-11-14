import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';

export type AccountUser = { id: string; email?: string; name: string };
type UserRow = { id: string; email: string | null; name: string };
type Credentials = { email?: unknown; password?: unknown; name?: unknown };
const sessionAgeSeconds = 30 * 24 * 60 * 60;
const hashOptions = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export async function initializeAccounts(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      name text NOT NULL,
      password_hash text,
      telegram_subject text UNIQUE,
      CHECK (
        (email IS NOT NULL AND password_hash IS NOT NULL AND telegram_subject IS NULL)
        OR (email IS NULL AND password_hash IS NULL AND telegram_subject IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions (expires_at);
  `);
}

export function accountError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message, details: null });
}

export function allowAccountOrigin(request: FastifyRequest, reply: FastifyReply, origin: string) {
  if (request.headers.origin === origin) return true;
  accountError(reply, 403, 'forbidden_origin', 'Откройте сайт афиши и повторите запрос.');
  return false;
}

export async function withAccountTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function publicUser(row: UserRow): AccountUser {
  return { id: row.id, name: row.name, ...(row.email === null ? {} : { email: row.email }) };
}

function sessionHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function requestTokenHash(request?: FastifyRequest) {
  const token = /(?:^|;\s*)afisha_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request?.headers.cookie ?? '')?.[1];
  return token ? sessionHash(token) : undefined;
}

function setSessionCookie(reply: FastifyReply, token: string, age: number, secure: boolean) {
  reply.header('set-cookie', 'afisha_session=' + token + '; Path=/; Max-Age=' + age + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''));
}

async function issueSession(db: Pool | PoolClient, userId: string, request?: FastifyRequest) {
  const token = randomBytes(32).toString('base64url');
  await db.query(`
    WITH removed AS (
      DELETE FROM account_sessions WHERE token_hash = $1 OR expires_at <= now()
    )
    INSERT INTO account_sessions (token_hash, user_id, expires_at)
    VALUES ($2, $3, now() + make_interval(secs => $4))
  `, [requestTokenHash(request) ?? null, sessionHash(token), userId, sessionAgeSeconds]);
  return token;
}

export async function createSession(pool: Pool, reply: FastifyReply, userId: string, secure: boolean, request?: FastifyRequest) {
  setSessionCookie(reply, await issueSession(pool, userId, request), sessionAgeSeconds, secure);
}

export async function getSession(pool: Pool, request: FastifyRequest): Promise<AccountUser | null> {
  const token = requestTokenHash(request);
  if (!token) return null;
  const { rows: [user] } = await pool.query<UserRow>(`
    SELECT u.id, u.email, u.name FROM account_sessions s
    JOIN account_users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now()
  `, [token]);
  return user ? publicUser(user) : null;
}

export async function upsertTelegramUser(pool: Pool, subject: string, name: string) {
  const { rows: [user] } = await pool.query<UserRow>(`
    INSERT INTO account_users (id, telegram_subject, name)
    VALUES ($1, $2, $3)
    ON CONFLICT (telegram_subject) DO UPDATE SET name = EXCLUDED.name
    RETURNING id, email, name
  `, [randomUUID(), subject, name]);
  return publicUser(user!);
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, hashOptions, (error, key) => error ? reject(error) : resolve(key));
  });
}

function readCredentials(body: Credentials | undefined) {
  if (typeof body?.email !== 'string' || typeof body.password !== 'string') return;
  const email = body.email.trim().toLowerCase();
  const { password } = body;
  if (email.length > 254 || !/^[^\s@\u0000]+@[^\s@\u0000]+\.[^\s@\u0000]+$/u.test(email)
    || password.length < 8 || password.length > 128) return;
  return { email, password };
}

export function registerAccounts(server: FastifyInstance, pool: Pool, options: { origin: string; telegramEnabled: boolean }) {
  const expectedOrigin = new URL(options.origin);
  const secure = expectedOrigin.protocol === 'https:';
  const accountWrite = {
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  };
  const account = (user: AccountUser | null) => ({ user, telegramEnabled: options.telegramEnabled });

  server.register(async auth => {
    auth.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (request.method === 'POST' && !allowAccountOrigin(request, reply, expectedOrigin.origin)) return reply;
    });

    auth.get('/session', async request => account(await getSession(pool, request)));

    auth.post<{ Body: Credentials }>('/register', accountWrite, async (request, reply) => {
      const credentials = readCredentials(request.body);
      const name = typeof request.body?.name === 'string' ? request.body.name.trim().toWellFormed() : '';
      if (!credentials || !name || name.length > 80 || name.includes('\u0000')) {
        return accountError(reply, 400, 'invalid_account', 'Укажите имя, электронную почту и пароль от 8 до 128 символов.');
      }
      const salt = randomBytes(16);
      const passwordHash = salt.toString('hex') + ':' + (await deriveKey(credentials.password, salt)).toString('hex');
      const registration = await withAccountTransaction(pool, async client => {
        const { rows: [user] } = await client.query<UserRow>(`
          INSERT INTO account_users (id, email, name, password_hash)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (email) DO NOTHING
          RETURNING id, email, name
        `, [randomUUID(), credentials.email, name, passwordHash]);
        return user ? { user, token: await issueSession(client, user.id, request) } : null;
      });
      if (!registration) return accountError(reply, 409, 'email_in_use', 'Аккаунт с этой почтой уже существует.');
      setSessionCookie(reply, registration.token, sessionAgeSeconds, secure);
      return reply.code(201).send(account(publicUser(registration.user)));
    });

    auth.post<{ Body: Credentials }>('/login', accountWrite, async (request, reply) => {
      const credentials = readCredentials(request.body);
      if (!credentials) return accountError(reply, 401, 'invalid_credentials', 'Неверная почта или пароль.');
      const { rows: [user] } = await pool.query<UserRow & { password_hash: string }>(`
        SELECT id, email, name, password_hash FROM account_users WHERE email = $1
      `, [credentials.email]);
      const [salt, key] = user?.password_hash.split(':').map(part => Buffer.from(part, 'hex')) ?? [];
      // Derive a key even for unknown emails to avoid an obvious timing difference.
      const derived = await deriveKey(credentials.password, salt ?? Buffer.alloc(16));
      if (!timingSafeEqual(derived, key ?? Buffer.alloc(64)) || !user) {
        return accountError(reply, 401, 'invalid_credentials', 'Неверная почта или пароль.');
      }
      await createSession(pool, reply, user.id, secure, request);
      return account(publicUser(user));
    });

    auth.post('/logout', async (request, reply) => {
      const token = requestTokenHash(request);
      if (token) await pool.query('DELETE FROM account_sessions WHERE token_hash = $1', [token]);
      setSessionCookie(reply, '', 0, secure);
      return reply.code(204).send();
    });
  }, { prefix: '/api/v1/auth' });
}
