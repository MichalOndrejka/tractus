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

test('workflow: default graph, save, validation, and 404', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'Flow', repo: 'owner/flow' },
  });
  const projectId = created.json().project.id;

  // Never-saved project returns the default pipeline (source + 4 roles).
  const def = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/workflow`,
    headers: authed(),
  });
  assert.equal(def.statusCode, 200);
  assert.ok(def.json().workflow.nodes.some((n: { kind: string }) => n.kind === 'source'));
  assert.ok(def.json().workflow.edges.length >= 1);

  // Save a custom graph; it comes back with updatedAt.
  const put = await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/workflow`,
    headers: authed(),
    payload: {
      nodes: [{ id: 'source', kind: 'source', label: 'Task Pool', x: 0, y: 0 }],
      edges: [],
    },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().workflow.nodes.length, 1);
  assert.ok(put.json().workflow.updatedAt);

  // Round-trips on the next GET.
  const after = await app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/workflow`,
    headers: authed(),
  });
  assert.equal(after.json().workflow.nodes.length, 1);

  // Bad payload (missing edges[]) is rejected.
  const bad = await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/workflow`,
    headers: authed(),
    payload: { nodes: [] },
  });
  assert.equal(bad.statusCode, 400);

  // Unknown project is 404.
  const missing = await app.inject({
    method: 'GET',
    url: '/api/projects/nope/workflow',
    headers: authed(),
  });
  assert.equal(missing.statusCode, 404);
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

test('github connection + repos guards (no token)', async () => {
  const conn = await app.inject({ method: 'GET', url: '/api/connection', headers: authed() });
  assert.equal(conn.statusCode, 200);
  assert.equal(conn.json().connected, false);

  const repos = await app.inject({ method: 'GET', url: '/api/github/repos', headers: authed() });
  assert.equal(repos.statusCode, 409); // requireToken -> GitHub not connected
});

test('conduit: status, connect (with health probe), and clear', async () => {
  const empty = await app.inject({ method: 'GET', url: '/api/conduit', headers: authed() });
  assert.equal(empty.statusCode, 200);

  // url required when neither url nor key is supplied against a fresh config.
  const noUrl = await app.inject({
    method: 'PUT',
    url: '/api/conduit',
    headers: authed(),
    payload: { apiKey: 'k' },
  });
  assert.equal(noUrl.statusCode, 400);

  // Point at a closed port so the health probe fails fast (healthy:false).
  const put = await app.inject({
    method: 'PUT',
    url: '/api/conduit',
    headers: authed(),
    payload: { url: 'http://127.0.0.1:1/mcp', apiKey: 'sk-test', memoryEnabled: true },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().connected, true);
  assert.equal(put.json().healthy, false);

  // apiKey-only update once a url exists, and a memory-flag-only update.
  await app.inject({
    method: 'PUT',
    url: '/api/conduit',
    headers: authed(),
    payload: { url: 'http://127.0.0.1:1/mcp' },
  });
  const keyOnly = await app.inject({
    method: 'PUT',
    url: '/api/conduit',
    headers: authed(),
    payload: { apiKey: 'sk-rotated' },
  });
  assert.equal(keyOnly.statusCode, 200);
  const flagOnly = await app.inject({
    method: 'PUT',
    url: '/api/conduit',
    headers: authed(),
    payload: { memoryEnabled: false },
  });
  assert.equal(flagOnly.statusCode, 200);
  assert.equal(flagOnly.json().memoryEnabled, false);

  const del = await app.inject({ method: 'DELETE', url: '/api/conduit', headers: authed() });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().connected, false);
});

test('providers: unknown id and missing token guards', async () => {
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/providers/bogus/connection',
    headers: authed(),
    payload: { method: 'api-key', token: 'x' },
  });
  assert.equal(unknown.statusCode, 404);

  const noToken = await app.inject({
    method: 'POST',
    url: '/api/providers/claude-code/connection',
    headers: authed(),
    payload: { method: 'subscription' },
  });
  assert.equal(noToken.statusCode, 400);

  const delUnknown = await app.inject({
    method: 'DELETE',
    url: '/api/providers/bogus/connection',
    headers: authed(),
  });
  assert.equal(delUnknown.statusCode, 404);
});

test('auth login: wrong creds 401, unknown email 401, correct creds 200', async () => {
  const wrongPw = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: 'not-the-password' },
  });
  assert.equal(wrongPw.statusCode, 401);

  const unknown = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'ghost@example.com', password: 'whatever' },
  });
  assert.equal(unknown.statusCode, 401);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: 'supersecret' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().authenticated, true);
});

test('project read / delete + order guards', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'Temp', repo: 'owner/temp' },
  });
  const id = created.json().project.id;

  const got = await app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: authed() });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().project.id, id);

  const missing = await app.inject({ method: 'GET', url: '/api/projects/nope', headers: authed() });
  assert.equal(missing.statusCode, 404);

  // order: 404 for unknown project, 400 for a bad payload.
  const badProj = await app.inject({
    method: 'PUT',
    url: '/api/projects/nope/order',
    headers: authed(),
    payload: { numbers: [1] },
  });
  assert.equal(badProj.statusCode, 404);
  const badBody = await app.inject({
    method: 'PUT',
    url: `/api/projects/${id}/order`,
    headers: authed(),
    payload: {},
  });
  assert.equal(badBody.statusCode, 400);
  const okOrder = await app.inject({
    method: 'PUT',
    url: `/api/projects/${id}/order`,
    headers: authed(),
    payload: { numbers: [3, 1, 2] },
  });
  assert.equal(okOrder.statusCode, 200);

  const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: authed() });
  assert.equal(del.statusCode, 200);
});

test('backlog + issue routes guard without GitHub / unknown project', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'Iss', repo: 'owner/iss' },
  });
  const id = created.json().project.id;

  // backlog: project ok but no GitHub token -> 409.
  const backlog = await app.inject({
    method: 'GET',
    url: `/api/projects/${id}/backlog`,
    headers: authed(),
  });
  assert.equal(backlog.statusCode, 409);

  // create issue: requireToken runs before the title check, so a tokenless
  // request short-circuits to 409; an unknown project is 404.
  const noToken = await app.inject({
    method: 'POST',
    url: `/api/projects/${id}/issues`,
    headers: authed(),
    payload: { body: 'x' },
  });
  assert.equal(noToken.statusCode, 409);
  const unknownProj = await app.inject({
    method: 'POST',
    url: '/api/projects/nope/issues',
    headers: authed(),
    payload: { title: 'x' },
  });
  assert.equal(unknownProj.statusCode, 404);

  // patch + delete issue guard on missing token.
  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${id}/issues/1`,
    headers: authed(),
    payload: { title: 'y' },
  });
  assert.equal(patch.statusCode, 409);
  const delIssue = await app.inject({
    method: 'DELETE',
    url: `/api/projects/${id}/issues/1`,
    headers: authed(),
  });
  assert.equal(delIssue.statusCode, 409);
});

test('input-validation 400 branches (no repo, bad template, empty conduit url)', async () => {
  const noRepo = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'x' },
  });
  assert.equal(noRepo.statusCode, 400);

  const proj = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'V', repo: 'owner/v' },
  });
  const badTemplate = await app.inject({
    method: 'POST',
    url: `/api/projects/${proj.json().project.id}/agents`,
    headers: authed(),
    payload: { templateId: 'does-not-exist' },
  });
  assert.equal(badTemplate.statusCode, 400);

  const emptyUrl = await app.inject({
    method: 'PUT',
    url: '/api/conduit',
    headers: authed(),
    payload: { url: '   ' },
  });
  assert.equal(emptyUrl.statusCode, 400);
});

test('unknown-project 404 guards across backlog / issues / workflow', async () => {
  const base = '/api/projects/nope';
  const cases: Array<[string, string, unknown]> = [
    ['GET', `${base}/backlog`, undefined],
    ['PATCH', `${base}/issues/1`, { title: 'x' }],
    ['DELETE', `${base}/issues/1`, undefined],
    ['GET', `${base}/agents`, undefined],
    ['POST', `${base}/agents`, { templateId: 'architect' }],
    ['GET', `${base}/workflow`, undefined],
    ['PUT', `${base}/workflow`, { nodes: [], edges: [] }],
  ];
  for (const [method, url, payload] of cases) {
    const res = await app.inject({ method: method as 'GET', url, headers: authed(), payload: payload as object });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
});

test('agent read / run / container guards (not found)', async () => {
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/agents/nope', headers: authed() })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/agents/nope',
        headers: authed(),
        payload: { dailyBudgetUsd: 1 },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/agents/nope/runs', headers: authed() })).json()
      .runs.length,
    0,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agents/nope/run',
        headers: authed(),
        payload: { workItemNumber: 1 },
      })
    ).statusCode,
    404,
  );
  // container routes: agent-not-found path avoids touching Docker.
  for (const url of ['/api/agents/nope/container', '/api/agents/nope/container/start', '/api/agents/nope/container/stop']) {
    const method = url.endsWith('container') ? 'GET' : 'POST';
    const res = await app.inject({ method, url, headers: authed(), payload: {} });
    assert.equal(res.statusCode, 404);
  }
});

test('snapshots + learning read/guard paths', async () => {
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/snapshots', headers: authed() })).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agents/nope/snapshot',
        headers: authed(),
        payload: {},
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/snapshots/nope/spawn',
        headers: authed(),
        payload: { projectId: 'x', count: 1 },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'DELETE', url: '/api/snapshots/nope', headers: authed() }))
      .statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/agents/nope/learning', headers: authed() }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agents/nope/learning/x/rollback',
        headers: authed(),
        payload: {},
      })
    ).statusCode,
    404,
  );
});

test('system + agent log read paths', async () => {
  const sys = await app.inject({ method: 'GET', url: '/api/system/logs', headers: authed() });
  assert.equal(sys.statusCode, 200);
  assert.ok(Array.isArray(sys.json().logs));

  // agent logs: 404 for unknown agent, 200 + [] for a freshly created one.
  const missing = await app.inject({ method: 'GET', url: '/api/agents/nope/logs', headers: authed() });
  assert.equal(missing.statusCode, 404);

  const proj = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'Logs', repo: 'owner/logs' },
  });
  const deployed = await app.inject({
    method: 'POST',
    url: `/api/projects/${proj.json().project.id}/agents`,
    headers: authed(),
    payload: { templateId: 'architect' },
  });
  const agentId = deployed.json().agent.id;
  const agentLogs = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/logs`, headers: authed() });
  assert.equal(agentLogs.statusCode, 200);
  assert.deepEqual(agentLogs.json().logs, []);
});

test('agent chat: history, guards, send round-trip, and clear', async () => {
  // 404s for an unknown agent across all three verbs.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/agents/nope/chat', headers: authed() })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agents/nope/chat',
        headers: authed(),
        payload: { message: 'hi' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'DELETE', url: '/api/agents/nope/chat', headers: authed() })).statusCode,
    404,
  );

  const proj = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: authed(),
    payload: { name: 'Chat', repo: 'owner/chat' },
  });
  const deployed = await app.inject({
    method: 'POST',
    url: `/api/projects/${proj.json().project.id}/agents`,
    headers: authed(),
    payload: { templateId: 'architect', name: 'Chatty' },
  });
  const agentId = deployed.json().agent.id;

  // Fresh thread is empty.
  const empty = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/chat`, headers: authed() });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().messages, []);

  // Empty message is rejected.
  const bad = await app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/chat`,
    headers: authed(),
    payload: { message: '   ' },
  });
  assert.equal(bad.statusCode, 400);

  // Use a non–Claude-Code provider so the reply path is deterministic and never
  // touches Docker. Send a message; get back the user line + an agent reply.
  await app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}`,
    headers: authed(),
    payload: { provider: 'codex' },
  });
  const sent = await app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/chat`,
    headers: authed(),
    payload: { message: 'hello there' },
  });
  assert.equal(sent.statusCode, 200);
  const msgs = sent.json().messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, 'hello there');
  assert.equal(msgs[1].role, 'agent');
  assert.ok(msgs[1].content.length > 0);
  // The response carries rolled-up chat usage (zero on the no-Docker fallback path).
  assert.ok(sent.json().usage);
  assert.equal(sent.json().usage.turns, 1);
  assert.equal(sent.json().usage.costUsd, 0);

  // Dedicated usage endpoint: 404 unknown, totals for this agent.
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/agents/nope/chat/usage', headers: authed() })).statusCode,
    404,
  );
  const usage = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/chat/usage`, headers: authed() });
  assert.equal(usage.statusCode, 200);
  assert.equal(usage.json().usage.turns, 1);

  // History now round-trips both lines in order.
  const hist = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/chat`, headers: authed() });
  assert.equal(hist.json().messages.length, 2);
  assert.equal(hist.json().messages[0].role, 'user');

  // Clear empties the thread.
  const cleared = await app.inject({ method: 'DELETE', url: `/api/agents/${agentId}/chat`, headers: authed() });
  assert.equal(cleared.statusCode, 200);
  const after = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/chat`, headers: authed() });
  assert.deepEqual(after.json().messages, []);
});

test('run logs read + budget pause toggle', async () => {
  const logs = await app.inject({ method: 'GET', url: '/api/runs/nope/logs', headers: authed() });
  assert.equal(logs.statusCode, 200);
  assert.deepEqual(logs.json().logs, []);

  const pause = await app.inject({
    method: 'POST',
    url: '/api/budget/pause',
    headers: authed(),
    payload: { paused: true },
  });
  assert.equal(pause.statusCode, 200);
  await app.inject({ method: 'POST', url: '/api/budget/pause', headers: authed(), payload: { paused: false } });
});

test('auth: logout clears the session', async () => {
  const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authed(), payload: {} });
  assert.equal(out.statusCode, 200);
});
