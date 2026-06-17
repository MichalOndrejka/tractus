import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh throwaway DB before importing the app (which imports db -> config).
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ac-http-')), 'test.sqlite');
const { app } = await import('../src/index.js');

let cookie = ''; // owner session, set by the signup test

before(async () => {
  await app.ready();
});

const authed = (extra: Record<string, string> = {}) => ({ cookie, ...extra });

test('health is public', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('auth: setup required, then signup bootstraps the owner', async () => {
  const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
  assert.equal(status.json().setupRequired, true);

  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'owner@example.com', password: 'supersecret' },
  });
  assert.equal(signup.statusCode, 200);
  assert.equal(signup.json().authenticated, true);
  const c = signup.cookies.find((x) => x.name === 'ac_session');
  assert.ok(c, 'session cookie set');
  cookie = `ac_session=${c!.value}`;
});

test('auth: protected route is 401 without a session, 200 with one', async () => {
  const no = await app.inject({ method: 'GET', url: '/api/projects' });
  assert.equal(no.statusCode, 401);

  const yes = await app.inject({ method: 'GET', url: '/api/projects', headers: authed() });
  assert.equal(yes.statusCode, 200);
  assert.deepEqual(yes.json().projects, []);
});

test('auth: signup is locked once an owner exists', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: 'intruder@example.com', password: 'supersecret' },
  });
  assert.equal(res.statusCode, 403);
});

test('providers: list, validation, connect + disconnect', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/providers', headers: authed() });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().providers.length >= 2);

  const codex = await app.inject({
    method: 'POST',
    url: '/api/providers/codex/connection',
    headers: authed(),
    payload: { method: 'api-key', token: 'x' },
  });
  assert.equal(codex.statusCode, 400); // not available yet

  const badMethod = await app.inject({
    method: 'POST',
    url: '/api/providers/claude-code/connection',
    headers: authed(),
    payload: { method: 'nonsense', token: 'x' },
  });
  assert.equal(badMethod.statusCode, 400);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/providers/claude-code/connection',
    headers: authed(),
    payload: { method: 'subscription', token: 'sk-oat-abc' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().connection.connected, true);

  const after = await app.inject({ method: 'GET', url: '/api/providers', headers: authed() });
  const cc = after.json().connections.find((c: { id: string }) => c.id === 'claude-code');
  assert.equal(cc.connected, true);

  const off = await app.inject({
    method: 'DELETE',
    url: '/api/providers/claude-code/connection',
    headers: authed(),
  });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().connection.connected, false);
});

test('projects + agents CRUD', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'Demo', repo: 'owner/demo' },
  });
  assert.equal(created.statusCode, 200);
  const projectId = created.json().project.id;

  const templates = await app.inject({ method: 'GET', url: '/api/agent-templates', headers: authed() });
  assert.ok(templates.json().templates.length >= 4);

  const deployed = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    headers: authed(),
    payload: { templateId: 'architect', name: 'Archie' },
  });
  assert.equal(deployed.statusCode, 200);
  const agent = deployed.json().agent;
  assert.equal(agent.role, 'architect');
  assert.equal(agent.provider, 'claude-code');

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/agents/${agent.id}`,
    headers: authed(),
    payload: { dailyBudgetUsd: 9 },
  });
  assert.equal(patched.json().agent.dailyBudgetUsd, 9);

  const list = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/agents`,
    headers: authed(),
  });
  assert.equal(list.json().agents.length, 1);

  const del = await app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}`, headers: authed() });
  assert.equal(del.statusCode, 200);
});

test('dispatch: always-on, and a tick is a no-op without GitHub', async () => {
  // Auto-dispatch is always on; a tick just no-ops when GitHub isn't connected.
  const tick = await app.inject({ method: 'POST', url: '/api/dispatch/tick', headers: authed(), payload: {} });
  assert.equal(tick.statusCode, 200);
  assert.equal(tick.json().enabled, true);
  assert.equal(tick.json().dispatched.length, 0); // no GitHub connected
});

test('budget + approvals read paths and guards', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/budget', headers: authed() })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/approvals', headers: authed() })).statusCode, 200);

  const bad = await app.inject({
    method: 'POST',
    url: '/api/approvals/nope/decide',
    headers: authed(),
    payload: { decision: 'maybe' },
  });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({
    method: 'POST',
    url: '/api/approvals/nope/decide',
    headers: authed(),
    payload: { decision: 'approved' },
  });
  assert.equal(missing.statusCode, 404);
});

test('auth: logout clears the session', async () => {
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authed(), payload: {} });
  assert.equal(out.statusCode, 200);
});
