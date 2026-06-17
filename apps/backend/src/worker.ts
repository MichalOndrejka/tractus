import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  type AgentRole,
  type BacklogItem,
  type BacklogState,
  type DeployedAgent,
  type LogStream,
  type Project,
  type Run,
} from '@tractus/shared';
import { config } from './config.js';
import {
  addBudgetCost,
  addLog,
  countRunningRuns,
  createApproval,
  createRun,
  finishRun,
  recentFailureStreak,
  getBudgetStatus,
  getGithubToken,
  getPositions,
  getProviderConnection,
  hasApprovedPlan,
  hasCompletedRunForRole,
  listActiveRuns,
  listAgents,
  listProjects,
  listRunningRuns,
  updateAgent,
} from './db.js';
import { fetchIssues, updateIssue } from './github.js';
import {
  type ContainerStatus,
  isWithinBudget,
  nextRoleForItem,
  pickupState,
  reconcileDecision,
  routeAfterRun,
} from './pipeline.js';
import { broadcast } from './ws.js';

/** Can we start another run right now? (concurrency + budget breaker) */
export function canDispatch(): { ok: boolean; reason?: string } {
  const budget = getBudgetStatus(countRunningRuns());
  if (budget.dispatchPaused) return { ok: false, reason: 'dispatch is paused (budget breaker)' };
  if (budget.runningAgents >= budget.concurrencyLimit) {
    return { ok: false, reason: `concurrency limit (${budget.concurrencyLimit}) reached` };
  }
  if (budget.costUsd >= budget.dailyLimitUsd) {
    return { ok: false, reason: 'daily budget reached' };
  }
  return { ok: true };
}

/**
 * Move a work item into the In Progress column on first pickup (from Ready/New),
 * then launch the agent run on it. The Architect plans (PLANNING) while other
 * roles implement/test (IN_PROGRESS) — both render in the In Progress column
 * with the right sub-stage tag. Mid-pipeline picks (IN_TESTING / IN_REVIEW) keep
 * their state. Shared by the manual run endpoint and the auto-dispatcher.
 */
export async function launchRun(opts: {
  agent: DeployedAgent;
  project: Project;
  item: BacklogItem;
  githubToken: string;
}): Promise<Run> {
  let item = opts.item;
  if (item.state === 'READY' || item.state === 'BACKLOG') {
    const target: BacklogState = pickupState(opts.agent.role);
    try {
      item = await updateIssue(opts.githubToken, opts.project.repo, item.number, { state: target });
      broadcast({ type: 'backlog.updated', item });
    } catch {
      /* best-effort; the run still launches */
    }
  }
  return runAgentOnItem({ ...opts, item });
}

export interface DispatchResult {
  enabled: boolean;
  dispatched: Array<{ projectId: string; itemNumber: number; agentId: string; agentName: string }>;
  reason?: string;
}

/** States the dispatcher can act on (everything else is human-gated or done). */
const DISPATCHABLE_STATES: BacklogState[] = ['READY', 'IN_TESTING', 'IN_REVIEW'];

/**
 * One dispatch pass driving the whole crew. For each project it fills free agent
 * slots by matching each dispatchable item to the role that should act on it
 * next (Architect → Developer → Tester → Reviewer). The board columns are the
 * queue (drag-rank = priority); `canDispatch()` (concurrency + budget) is the
 * admission control; items with a run already in flight are skipped, and any
 * that don't fit a slot simply wait for the next tick.
 *
 * Triggered by n8n (or any caller) via POST /api/dispatch/tick.
 */
export async function dispatchTick(): Promise<DispatchResult> {
  // Always-on: free agents pull Ready items automatically. (The budget breaker
  // in canDispatch() / dispatch_paused is the only thing that halts a pass.)
  const token = getGithubToken();
  if (!token) return { enabled: true, dispatched: [], reason: 'GitHub not connected' };

  const dispatched: DispatchResult['dispatched'] = [];
  for (const project of listProjects()) {
    if (!canDispatch().ok) break;
    // Idle agents grouped by role; those over their daily budget are skipped
    // (no effect under flat-cost subscriptions).
    const idle = listAgents(project.id).filter((a) => a.status === 'idle' && isWithinBudget(a));
    if (idle.length === 0) continue;
    const pools = {} as Record<AgentRole, DeployedAgent[]>;
    for (const a of idle) (pools[a.role] ??= []).push(a);

    let items;
    try {
      items = await fetchIssues(token, project.repo);
    } catch {
      continue; // skip this project this tick; try again next time
    }
    // Items with a run already in flight must not be dispatched again.
    const busy = new Set(listActiveRuns(project.repo).map((r) => r.issueNumber));
    const positions = getPositions(project.id);
    const candidates = items
      .filter((i) => DISPATCHABLE_STATES.includes(i.state) && !busy.has(i.number))
      .sort((a, b) => {
        const pa = positions.get(a.number);
        const pb = positions.get(b.number);
        if (pa != null && pb != null) return pa - pb;
        if (pa != null) return -1;
        if (pb != null) return 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });

    for (const item of candidates) {
      if (!canDispatch().ok) break;
      const role = nextRoleForItem(item.state, {
        planApproved: hasApprovedPlan(project.repo, item.number),
        reviewerDone: hasCompletedRunForRole(project.repo, item.number, 'reviewer'),
      });
      if (!role) continue;
      const agent = pools[role]?.shift();
      if (!agent) continue; // no idle agent for this stage — item waits
      await launchRun({ agent, project, item, githubToken: token });
      dispatched.push({
        projectId: project.id,
        itemNumber: item.number,
        agentId: agent.id,
        agentName: agent.name,
      });
    }
  }
  return { enabled: true, dispatched };
}

function emit(runId: string, stream: LogStream, content: string): void {
  const line = addLog(runId, stream, content);
  broadcast({ type: 'log', line });
}

/** Split a stream into lines and forward each non-empty line. */
function pipeLines(stream: Readable, onLine: (line: string) => void): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf.trim().length) onLine(buf);
  });
}

/** Everything the supervisor needs to drive a run to completion + route its item. */
interface RunContext {
  runId: string;
  repo: string;
  issueNumber: number;
  role: AgentRole;
  agentId: string;
  projectId: string | null;
  startedAt: string;
}

/** Deterministic container name for a run (so we can re-find it after a restart). */
const containerName = (runId: string): string => `ac-${runId.replace(/:/g, '-')}`;

const projectIdForRepo = (repo: string): string | null =>
  listProjects().find((p) => p.repo === repo)?.id ?? null;

const runContext = (run: Run): RunContext => ({
  runId: run.id,
  repo: run.repo,
  issueNumber: run.issueNumber,
  role: run.role,
  // runId is `${agent.id}:${nonce}`, so the agent id is recoverable after a restart.
  agentId: run.id.split(':')[0],
  projectId: projectIdForRepo(run.repo),
  startedAt: run.startedAt,
});

/**
 * When a run ends, advance its item through the crew pipeline and open the right
 * human gate. Adapts to which roles are deployed:
 *   architect  success -> PLAN_READY + Gate 1 (plan)
 *   developer  success -> IN_TESTING (if a Tester is deployed) else IN_REVIEW + Gate 2
 *   tester     success -> IN_REVIEW + Gate 2 (merge)
 *   reviewer           -> advisory; never changes state (summary is in logs)
 *   failure/kill       -> READY (retry), or BLOCKED past maxRetries
 * Best-effort; never throws into the run lifecycle. Pulls the GitHub token live so
 * it also works when called from startup reconciliation.
 */
function routeItemAfterRun(ctx: RunContext, ok: boolean): void {
  const route = routeAfterRun({
    role: ctx.role,
    ok,
    failureStreak: ok ? 0 : recentFailureStreak(ctx.repo, ctx.issueNumber),
    maxRetries: config.maxRetries,
    hasTester: ctx.projectId
      ? listAgents(ctx.projectId).some((a) => a.role === 'tester')
      : false,
  });
  if (!route) {
    emit(ctx.runId, 'system', ok ? 'review posted (advisory)' : 'reviewer run failed (non-blocking)');
    return;
  }
  if (route.state === 'BLOCKED') {
    emit(ctx.runId, 'system', `failed ${config.maxRetries}× — parking in BLOCKED (won't auto-retry)`);
  }
  const token = getGithubToken() ?? '';
  updateIssue(token, ctx.repo, ctx.issueNumber, { state: route.state })
    .then((moved) => {
      broadcast({ type: 'backlog.updated', item: moved });
      if (route.gate) {
        const approval = createApproval({ repo: ctx.repo, issueNumber: ctx.issueNumber, gate: route.gate });
        broadcast({ type: 'approval.updated', approval });
      }
    })
    .catch((err) => emit(ctx.runId, 'system', `could not move work item to ${route.state}: ${String(err)}`));
}

/** Close out a run as terminal: persist status, free the agent, route the item. */
function finalizeRun(
  ctx: RunContext,
  status: Run['status'],
  fields: { exitReason: string; prUrl?: string; tokensIn?: number; tokensOut?: number; costUsd?: number },
): void {
  const r = finishRun(ctx.runId, status, fields);
  addBudgetCost(fields.tokensIn ?? 0, fields.tokensOut ?? 0, fields.costUsd ?? 0);
  updateAgent(ctx.agentId, { status: 'idle' });
  if (r) broadcast({ type: 'run.updated', run: r });
  routeItemAfterRun(ctx, status === 'done');
}

/** Inspect a run's container: still running, exited (with code), or gone. */
function inspectContainer(name: string): Promise<ContainerStatus> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name], {
      windowsHide: true,
    });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.on('error', () => resolve({ kind: 'gone' }));
    p.on('close', (code) => {
      if (code !== 0) return resolve({ kind: 'gone' });
      const [running, exit] = out.trim().split(/\s+/);
      if (running === 'true') return resolve({ kind: 'running' });
      resolve({ kind: 'exited', exitCode: Number.parseInt(exit ?? '', 10) || 0 });
    });
  });
}

/**
 * Attach to a (running or freshly-launched) detached container: stream its logs
 * into the run, enforce a wall-clock timeout, and finalize on exit. Idempotent
 * and restart-safe — re-running it against a live container just resumes.
 *
 * Logs are streamed from the start so the `::pr::` / `::usage::` sentinels are
 * (re)captured even when we re-attach after a restart. Completion is taken from
 * `docker wait` (authoritative exit code); we finalize once logs have flushed.
 */
function superviseRun(ctx: RunContext): void {
  const name = containerName(ctx.runId);
  let capturedPrUrl: string | undefined;
  const usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  let exitCode: number | null = null;
  let logsClosed = false;
  let waited = false;
  let finalized = false;

  // Deadline is anchored to the run's start time, so it survives restarts.
  const remaining = config.runTimeoutMs - (Date.now() - new Date(ctx.startedAt).getTime());
  const timer = setTimeout(() => {
    emit(ctx.runId, 'system', 'run timed out — killing container');
    spawn('docker', ['kill', name], { windowsHide: true }).on('error', () => {});
  }, Math.max(1000, remaining));

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    const status: Run['status'] = exitCode === 0 ? 'done' : exitCode === null ? 'killed' : 'failed';
    emit(ctx.runId, 'system', `container exited (code ${exitCode ?? 'unknown'})`);
    finalizeRun(ctx, status, {
      exitReason: `exit ${exitCode}`,
      prUrl: capturedPrUrl,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costUsd: usage.costUsd,
    });
    // The container has exited; remove it now that we've harvested its result.
    spawn('docker', ['rm', '-f', name], { windowsHide: true }).on('error', () => {});
  };

  const logs = spawn('docker', ['logs', '-f', name], { windowsHide: true });
  logs.on('error', (err) => emit(ctx.runId, 'system', `docker logs error: ${err.message}`));
  pipeLines(logs.stdout, (line) => {
    const pr = line.match(/^::pr::(.+)$/);
    if (pr) {
      capturedPrUrl = pr[1].trim();
      emit(ctx.runId, 'system', `opened PR ${capturedPrUrl}`);
      return;
    }
    const u = line.match(/^::usage::(\d+),(\d+),([\d.]+)$/);
    if (u) {
      usage.tokensIn = Number(u[1]);
      usage.tokensOut = Number(u[2]);
      usage.costUsd = Number(u[3]);
      return;
    }
    emit(ctx.runId, 'stdout', line);
  });
  pipeLines(logs.stderr, (line) => emit(ctx.runId, 'stderr', line));
  logs.on('close', () => {
    logsClosed = true;
    if (waited) finalize();
  });

  const waiter = spawn('docker', ['wait', name], { windowsHide: true });
  waiter.on('error', () => {});
  pipeLines(waiter.stdout, (line) => {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(n)) exitCode = n;
  });
  waiter.on('close', () => {
    waited = true;
    if (logsClosed) finalize();
  });
}

/**
 * Launch a detached Docker container for one agent against one work item, then
 * supervise it. Detached (`docker run -d`, no `--rm`) so the container outlives a
 * backend restart and can be re-attached on boot. Returns the created run
 * immediately; completion is reported asynchronously via run.updated events.
 */
export function runAgentOnItem(opts: {
  agent: DeployedAgent;
  project: Project;
  item: BacklogItem;
  githubToken: string;
}): Run {
  const { agent, project, item, githubToken } = opts;
  const runId = `${agent.id}:${randomBytes(4).toString('hex')}`;

  const run = createRun({
    id: runId,
    repo: project.repo,
    issueNumber: item.number,
    role: agent.role,
    model: agent.model,
  });
  updateAgent(agent.id, { status: 'running' });
  broadcast({ type: 'run.updated', run });
  const ctx = runContext(run);

  const env: Record<string, string> = {
    DRY_RUN: config.dryRun ? '1' : '0',
    REPO: project.repo,
    GITHUB_TOKEN: githubToken,
    DEFAULT_BRANCH: project.defaultBranch ?? 'main',
    ISSUE_NUMBER: String(item.number),
    ISSUE_TITLE: item.title,
    ISSUE_BODY: item.body,
    AGENT_ROLE: agent.role,
    INSTRUCTIONS: agent.instructions,
    MODEL_ID: agent.model,
    PROVIDER: agent.provider,
  };
  // Inject the provider's auth. Prefer a UI-configured connection; fall back to
  // the legacy ANTHROPIC_API_KEY from .env for Claude Code.
  const conn = getProviderConnection(agent.provider);
  if (agent.provider === 'claude-code') {
    if (conn?.method === 'subscription') env.CLAUDE_CODE_OAUTH_TOKEN = conn.token;
    else if (conn?.method === 'api-key') env.ANTHROPIC_API_KEY = conn.token;
    else if (config.anthropicKey) env.ANTHROPIC_API_KEY = config.anthropicKey;
  } else if (conn?.token) {
    // Generic: future providers carry their key; entrypoint reads PROVIDER_TOKEN.
    env.PROVIDER_TOKEN = conn.token;
  }

  const args = ['run', '-d', '--name', containerName(runId)];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(config.agentImage);

  emit(
    runId,
    'system',
    `launching ${config.agentImage}${config.dryRun ? ' (DRY RUN — no repo changes, no tokens)' : ''}`,
  );

  let child;
  try {
    child = spawn('docker', args, { windowsHide: true });
  } catch (err) {
    emit(runId, 'system', `failed to launch docker: ${String(err)}`);
    finalizeRun(ctx, 'failed', { exitReason: String(err) });
    return run;
  }

  let launchErr = '';
  child.stdout.resume(); // detached run prints the container id; we don't need it
  pipeLines(child.stderr, (line) => (launchErr += `${line}\n`));
  child.on('error', (err) => {
    emit(runId, 'system', `docker error: ${err.message}`);
    finalizeRun(ctx, 'failed', { exitReason: err.message });
  });
  child.on('close', (code) => {
    if (code === 0) {
      superviseRun(ctx);
    } else {
      emit(runId, 'system', `failed to start container (exit ${code}): ${launchErr.trim()}`);
      finalizeRun(ctx, 'failed', { exitReason: `docker run exit ${code}` });
    }
  });

  return run;
}

/**
 * On startup, reconcile every run still marked `running` against its container so
 * the backend can be killed/restarted at any point without losing or stranding
 * work. For each orphan: re-attach if the container is still running, otherwise
 * finalize it (done/failed/killed) — freeing the agent and routing the item.
 */
export async function reconcileRunningRuns(): Promise<void> {
  const runs = listRunningRuns();
  if (runs.length === 0) return;
  for (const run of runs) {
    const ctx = runContext(run);
    const status = await inspectContainer(containerName(run.id));
    const decision = reconcileDecision(status);
    if (decision.action === 'reattach') {
      emit(run.id, 'system', 're-attached to running container after backend restart');
      superviseRun(ctx);
      continue;
    }
    const detail =
      status.kind === 'exited'
        ? `container had exited (code ${status.exitCode}) during downtime`
        : 'container was gone after restart';
    emit(run.id, 'system', `reconciling orphaned run — ${detail}`);
    finalizeRun(ctx, decision.status, {
      exitReason: status.kind === 'exited' ? `exit ${status.exitCode}` : 'container gone',
    });
  }
}
