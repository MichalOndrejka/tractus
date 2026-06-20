import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh DB + a machine dispatch token set BEFORE importing the app, so the
// onRequest guard's "machine trigger" branch (x-dispatch-token bypasses the
// browser session) is exercised. Runs in its own process, so the token doesn't
// leak into the main http suite (where it is intentionally unset).
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ac-dt-')), 'test.sqlite');
process.env.DISPATCH_TOKEN = 'machine-secret';
const { app } = await import('../src/index.js');

before(async () => {
  await app.ready();
});

test('signup validation rejects a bad email / short password (no owner yet)', async () => {
  const badEmail = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'not-an-email', password: 'longenough' },
  });
  assert.equal(badEmail.statusCode, 400);

  const shortPw = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'owner@example.com', password: 'short' },
  });
  assert.equal(shortPw.statusCode, 400);
});

test('login validation rejects empty credentials', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('dispatch tick: shared token bypasses the session guard', async () => {
  const ok = await app.inject({
    method: 'POST',
    url: '/api/dispatch/tick',
    headers: { 'x-dispatch-token': 'machine-secret' },
    payload: {},
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().enabled, true);
});

test('dispatch tick: a wrong / missing token still needs a session (401)', async () => {
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/dispatch/tick',
    headers: { 'x-dispatch-token': 'not-the-secret' },
    payload: {},
  });
  assert.equal(wrong.statusCode, 401);

  const none = await app.inject({ method: 'POST', url: '/api/dispatch/tick', payload: {} });
  assert.equal(none.statusCode, 401);
});
