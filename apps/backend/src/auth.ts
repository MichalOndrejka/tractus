import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';

const SESSION_COOKIE = 'ac_session';
const SESSION_TTL_DAYS = 30;

// --- password hashing (scrypt; no native deps) -----------------------------

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// --- user / session data ----------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export function userCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;
}

function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM user WHERE email = ?').get(email.toLowerCase()) as
    | UserRow
    | undefined;
}

function createUser(email: string, password: string): UserRow {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO user(id, email, password_hash, created_at) VALUES(?, ?, ?, ?)',
  ).run(id, email.toLowerCase(), hashPassword(password), createdAt);
  return { id, email: email.toLowerCase(), password_hash: '', created_at: createdAt };
}

function createSession(userId: string): string {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 86400_000);
  db.prepare(
    'INSERT INTO session(token, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)',
  ).run(token, userId, now.toISOString(), expires.toISOString());
  return token;
}

function userForToken(token: string | undefined): { id: string; email: string } | undefined {
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT u.id AS id, u.email AS email, s.expires_at AS expires_at
       FROM session s JOIN user u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as { id: string; email: string; expires_at: string } | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM session WHERE token = ?').run(token);
    return undefined;
  }
  return { id: row.id, email: row.email };
}

function deleteSession(token: string | undefined): void {
  if (token) db.prepare('DELETE FROM session WHERE token = ?').run(token);
}

// --- cookie helpers ---------------------------------------------------------

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86400,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function tokenFromReq(req: FastifyRequest): string | undefined {
  return (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Routes that don't require an authenticated session. */
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/signup']);

export function registerAuth(app: FastifyInstance): void {
  // Guard: every /api route except the public ones needs a valid session.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return; // ws + static handled elsewhere
    if (PUBLIC_PATHS.has(url)) return;
    // Machine trigger (n8n) may call the dispatch tick with the shared secret
    // instead of a browser session.
    if (url === '/api/dispatch/tick' && config.dispatchToken) {
      const header = req.headers['x-dispatch-token'];
      const provided = Array.isArray(header) ? header[0] : header;
      if (provided && provided === config.dispatchToken) return;
    }
    if (!userForToken(tokenFromReq(req))) {
      reply.code(401).send({ error: 'authentication required' });
    }
  });

  app.get('/api/auth/status', async (req) => {
    const user = userForToken(tokenFromReq(req));
    return {
      setupRequired: userCount() === 0,
      authenticated: Boolean(user),
      user: user ? { email: user.email } : undefined,
    };
  });

  // Sign-up is only allowed to bootstrap the single owner account.
  app.post('/api/auth/signup', async (req, reply) => {
    if (userCount() > 0) {
      return reply.code(403).send({ error: 'sign-up is closed; an owner already exists' });
    }
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !EMAIL_RE.test(email)) return reply.code(400).send({ error: 'valid email required' });
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' });
    }
    const user = createUser(email, password);
    setSessionCookie(reply, createSession(user.id));
    return { authenticated: true, user: { email: user.email } };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const user = email ? findUserByEmail(email) : undefined;
    if (!user || !password || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    setSessionCookie(reply, createSession(user.id));
    return { authenticated: true, user: { email: user.email } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    deleteSession(tokenFromReq(req));
    clearSessionCookie(reply);
    return { authenticated: false };
  });
}
