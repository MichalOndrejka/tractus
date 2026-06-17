import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import {
  AGENT_PROVIDERS_INFO,
  AGENT_TEMPLATES,
  type AgentProvider,
  type BacklogItemType,
  type BacklogState,
  type ProviderAuthMethod,
  type ProviderConnection,
} from '@tractus/shared';
import { config } from './config.js';
import {
  closeIssue,
  createIssue,
  fetchIssues,
  listRepos,
  updateIssue,
  validateToken,
} from './github.js';
import {
  clearGithubToken,
  clearProviderConnection,
  createAgent,
  createProject,
  decideApproval,
  deleteAgent,
  deleteProject,
  getApproval,
  getAgent,
  getBudgetStatus,
  getGithubToken,
  getPositions,
  getProject,
  getProviderConnection,
  latestPrUrlForItem,
  setProviderConnection,
  listActiveRuns,
  listAgents,
  listApprovals,
  listLogs,
  listProjects,
  listRuns,
  pendingApprovalFor,
  setGithubToken,
  setOrder,
  setState,
  updateAgent,
} from './db.js';
import { addClient, broadcast } from './ws.js';
import { registerAuth } from './auth.js';
import { canDispatch, dispatchTick, launchRun, reconcileRunningRuns } from './worker.js';

export const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
await app.register(websocket);

// auth guard + endpoints (must be registered before protected routes)
registerAuth(app);

/** Require a stored GitHub token, else 409. */
function requireToken(reply: import('fastify').FastifyReply): string | null {
  const token = getGithubToken();
  if (!token) {
    reply.code(409).send({ error: 'GitHub not connected' });
    return null;
  }
  return token;
}

// --- health ----------------------------------------------------------------

app.get('/api/health', async () => ({ ok: true, phase: 0 }));

// --- GitHub connection ------------------------------------------------------

app.get('/api/connection', async () => {
  const token = getGithubToken();
  if (!token) return { connected: false };
  try {
    return await validateToken(token);
  } catch {
    return { connected: false, error: 'stored token is invalid' };
  }
});

app.post('/api/connection', async (req, reply) => {
  const { token } = (req.body ?? {}) as { token?: string };
  if (!token) return reply.code(400).send({ error: 'token required' });
  try {
    const conn = await validateToken(token);
    setGithubToken(token);
    return conn;
  } catch {
    return reply.code(401).send({ error: 'invalid GitHub token' });
  }
});

app.delete('/api/connection', async () => {
  clearGithubToken();
  return { connected: false };
});

app.get('/api/github/repos', async (_req, reply) => {
  const token = requireToken(reply);
  if (!token) return;
  try {
    return { repos: await listRepos(token) };
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: 'failed to list repos' });
  }
});

// --- agentic system providers (per-agent; credentials connected here) -------

app.get('/api/providers', async () => {
  const connections: ProviderConnection[] = AGENT_PROVIDERS_INFO.map((p) => {
    const conn = getProviderConnection(p.id);
    return { id: p.id, connected: Boolean(conn), method: conn?.method };
  });
  return { providers: AGENT_PROVIDERS_INFO, connections };
});

app.post('/api/providers/:id/connection', async (req, reply) => {
  const { id } = req.params as { id: string };
  const info = AGENT_PROVIDERS_INFO.find((p) => p.id === id);
  if (!info) return reply.code(404).send({ error: 'unknown provider' });
  if (!info.available) return reply.code(400).send({ error: `${info.name} is not available yet` });
  const { method, token } = (req.body ?? {}) as { method?: ProviderAuthMethod; token?: string };
  if (method !== 'subscription' && method !== 'api-key') {
    return reply.code(400).send({ error: 'method must be "subscription" or "api-key"' });
  }
  if (!info.authMethods.includes(method)) {
    return reply.code(400).send({ error: `${info.name} does not support ${method}` });
  }
  if (!token || !token.trim()) return reply.code(400).send({ error: 'token required' });
  setProviderConnection(id, { method, token: token.trim() });
  const conn: ProviderConnection = { id: id as AgentProvider, connected: true, method };
  return { connection: conn };
});

app.delete('/api/providers/:id/connection', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!AGENT_PROVIDERS_INFO.find((p) => p.id === id)) {
    return reply.code(404).send({ error: 'unknown provider' });
  }
  clearProviderConnection(id);
  return { connection: { id: id as AgentProvider, connected: false } satisfies ProviderConnection };
});

// --- projects ---------------------------------------------------------------

app.get('/api/projects', async () => ({ projects: listProjects() }));

app.post('/api/projects', async (req, reply) => {
  const { name, repo, defaultBranch } = (req.body ?? {}) as {
    name?: string;
    repo?: string;
    defaultBranch?: string;
  };
  if (!repo) return reply.code(400).send({ error: 'repo required' });
  return {
    project: createProject({
      name: name?.trim() || repo,
      repo,
      defaultBranch: defaultBranch?.trim() || undefined,
    }),
  };
});

app.get('/api/projects/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  return { project };
});

app.delete('/api/projects/:id', async (req) => {
  const { id } = req.params as { id: string };
  deleteProject(id);
  return { ok: true };
});

// --- backlog (per project, from GitHub Issues) ------------------------------

app.get('/api/projects/:id/backlog', async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  const token = requireToken(reply);
  if (!token) return;
  try {
    const items = await fetchIssues(token, project.repo);
    const positions = getPositions(id);
    // Map each item to the agent currently running on it (if any).
    const active = new Map<number, { role: import('@tractus/shared').AgentRole; agentName: string; runId: string }>();
    for (const run of listActiveRuns(project.repo)) {
      if (active.has(run.issueNumber)) continue; // keep most recent
      const agent = getAgent(run.id.split(':')[0]);
      active.set(run.issueNumber, {
        role: run.role,
        agentName: agent?.name ?? run.role,
        runId: run.id,
      });
    }
    for (const item of items) {
      item.position = positions.get(item.number);
      item.activeAgent = active.get(item.number);
      item.pendingApproval = pendingApprovalFor(project.repo, item.number);
      item.prUrl = latestPrUrlForItem(project.repo, item.number) ?? item.prUrl;
    }
    return { items };
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: 'failed to fetch issues' });
  }
});

// Persist a column's ordering (drag-to-rank). position = index in the array.
app.put('/api/projects/:id/order', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getProject(id)) return reply.code(404).send({ error: 'project not found' });
  const { numbers } = (req.body ?? {}) as { numbers?: number[] };
  if (!Array.isArray(numbers)) return reply.code(400).send({ error: 'numbers[] required' });
  setOrder(id, numbers);
  return { ok: true };
});

app.post('/api/projects/:id/issues', async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  const token = requireToken(reply);
  if (!token) return;
  const body = (req.body ?? {}) as {
    title?: string;
    body?: string;
    type?: BacklogItemType;
    priority?: number;
  };
  const title = body.title;
  if (!title) return reply.code(400).send({ error: 'title required' });
  try {
    const item = await createIssue(token, project.repo, { ...body, title });
    return { item };
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: 'failed to create issue' });
  }
});

app.patch('/api/projects/:id/issues/:number', async (req, reply) => {
  const { id, number } = req.params as { id: string; number: string };
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  const token = requireToken(reply);
  if (!token) return;
  const patch = (req.body ?? {}) as {
    state?: BacklogState;
    priority?: number;
    type?: BacklogItemType;
    title?: string;
    body?: string;
  };
  try {
    const item = await updateIssue(token, project.repo, Number(number), patch);
    return { item };
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: 'failed to update issue' });
  }
});

app.delete('/api/projects/:id/issues/:number', async (req, reply) => {
  const { id, number } = req.params as { id: string; number: string };
  const project = getProject(id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  const token = requireToken(reply);
  if (!token) return;
  try {
    await closeIssue(token, project.repo, Number(number));
    return { ok: true };
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: 'failed to delete issue' });
  }
});

// --- agents -----------------------------------------------------------------

app.get('/api/agent-templates', async () => ({ templates: AGENT_TEMPLATES }));

app.get('/api/projects/:id/agents', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getProject(id)) return reply.code(404).send({ error: 'project not found' });
  return { agents: listAgents(id) };
});

app.post('/api/projects/:id/agents', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getProject(id)) return reply.code(404).send({ error: 'project not found' });
  const body = (req.body ?? {}) as {
    templateId?: string;
    name?: string;
    provider?: string;
    model?: string;
    dailyBudgetUsd?: number;
    instructions?: string;
    skills?: Array<{ id: string; name: string; content: string }>;
  };
  const template = AGENT_TEMPLATES.find((t) => t.id === body.templateId);
  if (!template) return reply.code(400).send({ error: 'unknown template' });
  const agent = createAgent({
    projectId: id,
    templateId: template.id,
    role: template.role,
    name: body.name?.trim() || template.name,
    provider: body.provider || template.provider,
    model: body.model || template.model,
    dailyBudgetUsd: body.dailyBudgetUsd ?? template.defaultDailyBudgetUsd,
    instructions: body.instructions ?? template.instructions,
    skills: body.skills ?? template.skills,
  });
  return { agent };
});

app.get('/api/agents/:agentId', async (req, reply) => {
  const { agentId } = req.params as { agentId: string };
  const agent = getAgent(agentId);
  if (!agent) return reply.code(404).send({ error: 'agent not found' });
  return { agent };
});

app.patch('/api/agents/:agentId', async (req, reply) => {
  const { agentId } = req.params as { agentId: string };
  const patch = (req.body ?? {}) as {
    dailyBudgetUsd?: number;
    status?: string;
    name?: string;
    provider?: string;
    model?: string;
    instructions?: string;
    skills?: Array<{ id: string; name: string; content: string }>;
  };
  const agent = updateAgent(agentId, patch);
  if (!agent) return reply.code(404).send({ error: 'agent not found' });
  return { agent };
});

app.delete('/api/agents/:agentId', async (req) => {
  const { agentId } = req.params as { agentId: string };
  deleteAgent(agentId);
  return { ok: true };
});

app.get('/api/agents/:agentId/runs', async (req) => {
  const { agentId } = req.params as { agentId: string };
  const runs = listRuns().filter((r) => r.id.startsWith(`${agentId}:`));
  return { runs };
});

// Launch a real run: spin up a Docker container for this agent on a work item.
app.post('/api/agents/:agentId/run', async (req, reply) => {
  const { agentId } = req.params as { agentId: string };
  const agent = getAgent(agentId);
  if (!agent) return reply.code(404).send({ error: 'agent not found' });
  const project = getProject(agent.projectId);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  const token = getGithubToken();
  if (!token) return reply.code(409).send({ error: 'GitHub not connected' });

  const { workItemNumber } = (req.body ?? {}) as { workItemNumber?: number };
  if (!workItemNumber) return reply.code(400).send({ error: 'workItemNumber required' });

  const gate = canDispatch();
  if (!gate.ok) return reply.code(429).send({ error: gate.reason });

  let item;
  try {
    const items = await fetchIssues(token, project.repo);
    item = items.find((i) => i.number === Number(workItemNumber));
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: 'failed to load work item from GitHub' });
  }
  if (!item) return reply.code(404).send({ error: 'work item not found' });

  const run = await launchRun({ agent, project, item, githubToken: token });
  return { run };
});

// --- dispatch (auto-pickup of Ready items) ----------------------------------
// Always-on: free agents pull the top Ready items automatically. The Ready
// column is the queue; canDispatch() is the admission control. The internal
// loop below drives it; n8n may also call /api/dispatch/tick on a schedule with
// the shared DISPATCH_TOKEN. (The budget breaker is the only halt.)

// One dispatch pass. Auth: a browser session OR the x-dispatch-token header.
app.post('/api/dispatch/tick', async () => dispatchTick());

// --- shared operational state ----------------------------------------------

app.get('/api/runs/:id/logs', async (req) => {
  const { id } = req.params as { id: string };
  return { logs: listLogs(id) };
});

app.get('/api/approvals', async (req) => {
  const { state } = req.query as { state?: 'pending' | 'approved' | 'rejected' };
  return { approvals: listApprovals(state) };
});

// Decide a gate. Gate 1 (plan): approve -> READY (Developer picks up), reject ->
// BACKLOG. Gate 2 (merge): approve -> DONE, reject -> READY (re-implement).
app.post('/api/approvals/:id/decide', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { decision, comment } = (req.body ?? {}) as {
    decision?: 'approved' | 'rejected';
    comment?: string;
  };
  if (decision !== 'approved' && decision !== 'rejected') {
    return reply.code(400).send({ error: 'decision must be "approved" or "rejected"' });
  }
  const approval = getApproval(id);
  if (!approval) return reply.code(404).send({ error: 'approval not found' });
  if (approval.state !== 'pending') return reply.code(409).send({ error: 'approval already decided' });
  const token = requireToken(reply);
  if (!token) return;

  const nextState: BacklogState =
    approval.gate === 'plan'
      ? decision === 'approved'
        ? 'READY'
        : 'BACKLOG'
      : decision === 'approved'
        ? 'DONE'
        : 'READY';

  const decided = decideApproval(id, decision, comment);
  try {
    const item = await updateIssue(token, approval.repo, approval.issueNumber, { state: nextState });
    broadcast({ type: 'backlog.updated', item });
  } catch (err) {
    app.log.error(err);
    return reply.code(502).send({ error: 'decided, but failed to update the work item state' });
  }
  if (decided) broadcast({ type: 'approval.updated', approval: decided });
  return { approval: decided };
});

app.get('/api/budget', async () => {
  const running = listRuns().filter((r) => r.status === 'running').length;
  return { budget: getBudgetStatus(running) };
});

app.post('/api/budget/pause', async (req) => {
  const { paused } = (req.body ?? {}) as { paused?: boolean };
  setState('dispatch_paused', paused ? 'true' : 'false');
  return { ok: true };
});

// --- live updates -----------------------------------------------------------

app.register(async (instance) => {
  instance.get('/ws', { websocket: true }, (socket) => {
    addClient(socket);
    socket.send(JSON.stringify({ type: 'hello', phase: 0 }));
  });
});

const start = async () => {
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Tractus backend on http://localhost:${config.port}`);
    // Recover from any prior crash/restart: re-attach to still-running agent
    // containers and finalize the rest, so no run is left stranded as `running`.
    await reconcileRunningRuns().catch((err) => app.log.error(err, 'run reconciliation failed'));
    // Internal auto-dispatch loop: every tick, free agents pull Ready items.
    // Runs only when bound directly (not under tests); .unref() so it never keeps
    // the process alive on its own. An external n8n trigger remains optional.
    if (config.dispatchIntervalMs > 0) {
      setInterval(() => {
        dispatchTick()
          .then((r) => {
            if (r.dispatched.length) app.log.info({ dispatched: r.dispatched }, 'auto-dispatch');
          })
          .catch((err) => app.log.error(err, 'auto-dispatch tick failed'));
      }, config.dispatchIntervalMs).unref();
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// Only bind a port when run directly (e.g. `tsx src/index.ts`). When imported by
// tests we just want the configured app for app.inject().
if (import.meta.main) void start();
