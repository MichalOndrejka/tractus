import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  AGENT_TEMPLATES,
  type AgentRole,
  type AgentSnapshot,
  type BacklogItem,
  type BacklogState,
  type ContainerState,
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
  createSnapshot,
  finishRun,
  recentFailureStreak,
  getAgent,
  getBudgetStatus,
  getConduitConfig,
  getGithubToken,
  getState,
  isMemoryEnabled,
  getPositions,
  setState,
  getProviderConnection,
  hasApprovedPlan,
  hasCompletedRunForRole,
  latestRunForItem,
  listActiveRuns,
  listAgents,
  listLogs,
  listProjects,
  listRunningRuns,
  recordLearning,
  updateAgent,
} from './db.js';
import { fetchIssues, updateIssue } from './github.js';
import {
  isWithinBudget,
  nextRoleForItem,
  pickupState,
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

// ---------------------------------------------------------------------------
// Persistent per-agent containers
// ---------------------------------------------------------------------------

/** Deterministic container name for an agent (UUID -> no escaping needed). */
const agentContainerName = (agentId: string): string => `tractus-agent-${agentId}`;

/** Image a fresh agent container is created from (its trained snapshot, else base). */
const imageForAgent = (agent: DeployedAgent): string => agent.imageTag || config.agentImage;

/** Last time each container finished work — drives the idle reaper. */
const lastUsed = new Map<string, number>();
const touchContainer = (name: string): void => void lastUsed.set(name, Date.now());

/** Run a one-shot docker command, resolving its exit code + captured stdout. */
function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (stdout += d));
    p.stderr.on('data', (d: string) => (stderr += d));
    p.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr || String(err) }));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** running | stopped | absent for an agent's container. */
async function inspectContainerState(name: string): Promise<ContainerState> {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (r.code !== 0) return 'absent';
  return r.stdout.trim() === 'true' ? 'running' : 'stopped';
}

export async function containerStatusFor(agent: DeployedAgent): Promise<{
  agentId: string;
  name: string;
  state: ContainerState;
  image?: string;
}> {
  const name = agentContainerName(agent.id);
  const state = await inspectContainerState(name);
  return { agentId: agent.id, name, state, image: state === 'absent' ? undefined : imageForAgent(agent) };
}

/** Create (if needed) and start an agent's persistent container; idempotent. */
export async function ensureAgentContainer(agent: DeployedAgent): Promise<void> {
  const name = agentContainerName(agent.id);
  const state = await inspectContainerState(name);
  if (state === 'running') {
    touchContainer(name);
    return;
  }
  if (state === 'absent') {
    const create = await docker(['create', '--name', name, imageForAgent(agent)]);
    if (create.code !== 0) throw new Error(`docker create failed: ${create.stderr.trim()}`);
  }
  const start = await docker(['start', name]);
  if (start.code !== 0) throw new Error(`docker start failed: ${start.stderr.trim()}`);
  touchContainer(name);
}

/**
 * Filesystem prefixes that signal a real environment change worth persisting:
 * installed packages, self-updates, global npm, etc. We deliberately ignore the
 * run scratch/cache area (/work, /tmp) and per-user caches so routine per-run
 * repo churn doesn't trigger a commit — only genuine tooling changes do.
 */
const SIGNIFICANT_PREFIXES = [
  '/usr',
  '/etc',
  '/opt',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/var/lib',
  '/root/.local',
];

/** The significant (tooling) lines of a `docker diff`, sorted for a stable signature. */
export function significantDiffLines(diff: string, prefixes: string[] = SIGNIFICANT_PREFIXES): string[] {
  const out: string[] = [];
  for (const raw of diff.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // docker diff lines are "<C|A|D> <path>"
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const path = line.slice(sp + 1);
    if (prefixes.some((p) => path === p || path.startsWith(`${p}/`))) out.push(line);
  }
  return out.sort();
}

/** True if `docker diff` output touches any significant (tooling) path. */
export function envChangedFromDiff(diff: string, prefixes: string[] = SIGNIFICANT_PREFIXES): boolean {
  return significantDiffLines(diff, prefixes).length > 0;
}

/** Stable per-agent image tag its trained environment is auto-committed to. */
const autoImageTag = (agent: DeployedAgent): string =>
  `${config.agentImagePrefix}${agent.role}:agent-${agent.id}`;

const envSigKey = (agentId: string): string => `agent_env_sig:${agentId}`;

/**
 * Auto-persist the agent's environment to its own image when it has *changed*
 * since the last save (tooling installed / self-update). `docker diff` is taken
 * against the image the container was created from — not the last commit — so we
 * compare a signature of the significant changes to what we last committed and
 * only commit when it actually differs (no per-run image bloat). Keeps the
 * trained state durable and inherited by spawned copies; best-effort.
 */
export async function autoCommitIfChanged(agentId: string, runId?: string): Promise<void> {
  if (!config.autoSnapshot) return;
  const agent = getAgent(agentId);
  if (!agent) return;
  const name = agentContainerName(agentId);
  try {
    if ((await inspectContainerState(name)) === 'absent') return;
    const diff = await docker(['diff', name]);
    if (diff.code !== 0) return;
    const lines = significantDiffLines(diff.stdout);
    if (lines.length === 0) return;
    const sig = createHash('sha256').update(lines.join('\n')).digest('hex');
    if (getState(envSigKey(agentId)) === sig) return; // nothing new since last save
    const tag = autoImageTag(agent);
    const commit = await docker(['commit', name, tag]);
    if (commit.code !== 0) return;
    setState(envSigKey(agentId), sig);
    if (agent.imageTag !== tag) updateAgent(agentId, { imageTag: tag });
    if (runId) emit(runId, 'system', `environment changed — auto-saved to ${tag}`);
  } catch {
    /* best-effort; never disrupt the run lifecycle */
  }
}

/** Stop an agent's container now (it persists; started again on next dispatch). */
export async function stopAgentContainer(agentId: string): Promise<void> {
  const name = agentContainerName(agentId);
  await docker(['stop', name]);
  lastUsed.delete(name);
}

/** Is a run still in flight for this agent? */
const agentHasRunningRun = (agentId: string): boolean =>
  listRunningRuns().some((r) => r.id.startsWith(`${agentId}:`));

/**
 * Stop containers that have been idle longer than the configured threshold to
 * free resources. Called from the dispatch loop. Containers with a live run are
 * kept (and their idle clock reset); the rest are stopped once past the window.
 */
export async function reapIdleContainers(): Promise<void> {
  const now = Date.now();
  for (const [name, ts] of [...lastUsed]) {
    if (now - ts < config.agentIdleStopMs) continue;
    const agentId = name.slice('tractus-agent-'.length);
    if (agentHasRunningRun(agentId)) {
      lastUsed.set(name, now);
      continue;
    }
    if ((await inspectContainerState(name)) === 'running') {
      await docker(['stop', name]);
    }
    lastUsed.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

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

/** Accumulated result parsed out of a run's log stream. */
interface RunResult {
  prUrl?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  exitCode: number | null;
}

/** Parse one log line for the run's sentinels, mutating the accumulator.
 *  Returns the printable line, or null if the line was a sentinel. */
function parseSentinel(line: string, acc: RunResult): string | null {
  const pr = line.match(/^::pr::(.+)$/);
  if (pr) {
    acc.prUrl = pr[1].trim();
    return null;
  }
  const u = line.match(/^::usage::(\d+),(\d+),([\d.]+)$/);
  if (u) {
    acc.tokensIn = Number(u[1]);
    acc.tokensOut = Number(u[2]);
    acc.costUsd = Number(u[3]);
    return null;
  }
  const ex = line.match(/^::exit::(-?\d+)$/);
  if (ex) {
    acc.exitCode = Number(ex[1]);
    return null;
  }
  return line;
}

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
  // Mark the container idle so the reaper can reclaim it after the grace window.
  touchContainer(agentContainerName(ctx.agentId));
  routeItemAfterRun(ctx, status === 'done');
  // Auto-persist environment changes (installed tooling / self-update) to the
  // agent's own image — durable and inherited by copies, no manual snapshot. The
  // signature gate makes this a no-op when nothing changed, so calling it on every
  // run end (and again after reflection) is cheap and idempotent.
  void autoCommitIfChanged(ctx.agentId, ctx.runId);
  // Learn from failures here; successes are reflected on after the human gate
  // decides (see reflectOnApproval), so the human's feedback informs the lesson.
  if (status !== 'done') kickReflection(ctx.agentId, ctx.runId, `run ${status}`);
}

const statusForExit = (exitCode: number | null): Run['status'] =>
  exitCode === 0 ? 'done' : exitCode === null ? 'killed' : 'failed';

/**
 * Tail a run's log out of its persistent container and finalize when the run
 * emits its `::exit::` sentinel (mirrored to /work/run.status for restart
 * recovery). Restart-safe: `fromStart:false` reattaches to an in-flight run and
 * streams only new lines. Enforces the wall-clock timeout anchored to the run's
 * start so it survives a backend restart.
 */
function superviseRun(ctx: RunContext, opts: { fromStart: boolean }): void {
  const name = agentContainerName(ctx.agentId);
  const acc: RunResult = { tokensIn: 0, tokensOut: 0, costUsd: 0, exitCode: null };
  let finalized = false;

  const remaining = config.runTimeoutMs - (Date.now() - new Date(ctx.startedAt).getTime());
  let tail: ReturnType<typeof spawn> | null = null;

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    tail?.kill();
    emit(ctx.runId, 'system', `run ended (exit ${acc.exitCode ?? 'unknown'})`);
    finalizeRun(ctx, statusForExit(acc.exitCode), {
      exitReason: `exit ${acc.exitCode}`,
      prUrl: acc.prUrl,
      tokensIn: acc.tokensIn,
      tokensOut: acc.tokensOut,
      costUsd: acc.costUsd,
    });
  };

  const timer = setTimeout(() => {
    emit(ctx.runId, 'system', 'run timed out — killing task');
    docker(['exec', name, 'sh', '-c', 'kill -9 "$(cat /work/run.pid 2>/dev/null)" 2>/dev/null']).catch(
      () => {},
    );
    finalize(); // exitCode stays null -> killed
  }, Math.max(1000, remaining));

  // `-F` follows + retries if the file is briefly missing (run-task truncates it
  // at the very start of each run). `-n +1` replays from the top on first attach.
  const from = opts.fromStart ? '+1' : '0';
  tail = spawn('docker', ['exec', name, 'tail', '-n', from, '-F', '/work/run.log'], {
    windowsHide: true,
  });
  tail.on('error', (err) => emit(ctx.runId, 'system', `log tail error: ${err.message}`));
  pipeLines(tail.stdout!, (line) => {
    const printable = parseSentinel(line, acc);
    if (printable !== null) emit(ctx.runId, 'stdout', printable);
    if (acc.exitCode !== null) finalize();
  });
  // If the tail dies without us seeing `::exit::` (container stopped/gone), fall
  // back to the durable status file before deciding the run's fate.
  tail.on('close', () => {
    if (finalized) return;
    void finalizeFromStatus(ctx);
  });
}

/** Read /work/run.status (the durable exit code), or null if the run is unfinished. */
async function readRunStatus(name: string): Promise<number | null> {
  const r = await docker(['exec', name, 'cat', '/work/run.status']);
  if (r.code !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isInteger(n) ? n : null;
}

/** Is the run-task process still alive inside the container? */
async function isRunAlive(name: string): Promise<boolean> {
  const r = await docker(['exec', name, 'sh', '-c', 'kill -0 "$(cat /work/run.pid 2>/dev/null)" 2>/dev/null']);
  return r.code === 0;
}

/** Harvest the full run log for sentinels (used when finalizing after downtime). */
async function harvestFromLog(name: string, acc: RunResult): Promise<void> {
  const r = await docker(['exec', name, 'cat', '/work/run.log']);
  if (r.code !== 0) return;
  for (const line of r.stdout.split('\n')) {
    if (line.trim().length) parseSentinel(line, acc);
  }
}

/** Finalize a run from its durable status file (tail closed without `::exit::`). */
async function finalizeFromStatus(ctx: RunContext): Promise<void> {
  const name = agentContainerName(ctx.agentId);
  const acc: RunResult = { tokensIn: 0, tokensOut: 0, costUsd: 0, exitCode: null };
  await harvestFromLog(name, acc);
  const status = await readRunStatus(name);
  acc.exitCode = status; // null -> killed
  emit(ctx.runId, 'system', `run finalized after stream closed (exit ${status ?? 'unknown'})`);
  finalizeRun(ctx, statusForExit(acc.exitCode), {
    exitReason: `exit ${status ?? 'gone'}`,
    prUrl: acc.prUrl,
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    costUsd: acc.costUsd,
  });
}

/**
 * Launch one agent run on one work item inside the agent's persistent container.
 * Ensures the container is up, then `docker exec -d`s run-task.sh (detached so it
 * outlives a backend restart) and supervises it by tailing its log. Returns the
 * created run immediately; completion is reported asynchronously via run.updated.
 */
export async function runAgentOnItem(opts: {
  agent: DeployedAgent;
  project: Project;
  item: BacklogItem;
  githubToken: string;
}): Promise<Run> {
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

  // Shared team memory: wire the conduit MCP server into the run when connected
  // and not globally disabled. run-task.sh writes the MCP config + memory preamble.
  if (isMemoryEnabled()) {
    const conduit = getConduitConfig();
    if (conduit?.url) {
      env.CONDUIT_MCP_URL = conduit.url;
      if (conduit.apiKey) env.CONDUIT_API_KEY = conduit.apiKey;
    }
  }

  try {
    await ensureAgentContainer(agent);
  } catch (err) {
    emit(runId, 'system', `failed to start agent container: ${String(err)}`);
    finalizeRun(ctx, 'failed', { exitReason: String(err) });
    return run;
  }

  const name = agentContainerName(agent.id);
  const args = ['exec', '-d'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(name, '/usr/local/bin/run-task.sh');

  emit(
    runId,
    'system',
    `running in ${name}${config.dryRun ? ' (DRY RUN — no repo changes, no tokens)' : ''}`,
  );

  const child = spawn('docker', args, { windowsHide: true });
  let launchErr = '';
  child.stdout.resume();
  pipeLines(child.stderr, (line) => (launchErr += `${line}\n`));
  child.on('error', (err) => {
    emit(runId, 'system', `docker exec error: ${err.message}`);
    finalizeRun(ctx, 'failed', { exitReason: err.message });
  });
  child.on('close', (code) => {
    if (code === 0) {
      superviseRun(ctx, { fromStart: true });
    } else {
      emit(runId, 'system', `failed to start task (exit ${code}): ${launchErr.trim()}`);
      finalizeRun(ctx, 'failed', { exitReason: `docker exec exit ${code}` });
    }
  });

  return run;
}

/**
 * On startup, reconcile every run still marked `running` so the backend can be
 * killed/restarted at any point without losing or stranding work. For each:
 *   - container absent          -> finalize (killed)
 *   - run already wrote status  -> finalize with that exit code (completed during downtime)
 *   - run process still alive   -> reattach and resume streaming
 *   - otherwise                 -> finalize (killed)
 */
export async function reconcileRunningRuns(): Promise<void> {
  const runs = listRunningRuns();
  if (runs.length === 0) return;
  for (const run of runs) {
    const ctx = runContext(run);
    const name = agentContainerName(ctx.agentId);
    const state = await inspectContainerState(name);
    if (state === 'absent') {
      emit(run.id, 'system', 'agent container gone after restart — finalizing as killed');
      finalizeRun(ctx, 'killed', { exitReason: 'container gone' });
      continue;
    }
    if (state === 'stopped') {
      const started = await docker(['start', name]); // bring it up so we can inspect the run
      if (started.code !== 0) {
        emit(run.id, 'system', 'could not restart agent container — finalizing as killed');
        finalizeRun(ctx, 'killed', { exitReason: 'container would not start' });
        continue;
      }
    }
    touchContainer(name);
    const status = await readRunStatus(name);
    if (status !== null) {
      emit(run.id, 'system', `run had completed during downtime (exit ${status})`);
      const acc: RunResult = { tokensIn: 0, tokensOut: 0, costUsd: 0, exitCode: status };
      await harvestFromLog(name, acc);
      finalizeRun(ctx, statusForExit(status), {
        exitReason: `exit ${status}`,
        prUrl: acc.prUrl,
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
        costUsd: acc.costUsd,
      });
      continue;
    }
    if (await isRunAlive(name)) {
      emit(run.id, 'system', 're-attached to running task after backend restart');
      superviseRun(ctx, { fromStart: false });
    } else {
      emit(run.id, 'system', 'task process gone with no status — finalizing as killed');
      finalizeRun(ctx, 'killed', { exitReason: 'task process gone' });
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot & multiply (capture a trained agent, spawn copies)
// ---------------------------------------------------------------------------

/** Commit an agent's container to a per-type image and record a reusable snapshot. */
export async function snapshotAgent(agent: DeployedAgent, notes?: string): Promise<AgentSnapshot> {
  const name = agentContainerName(agent.id);
  if ((await inspectContainerState(name)) === 'absent') {
    throw new Error('agent has no container yet — run it at least once before snapshotting');
  }
  const tag = `${config.agentImagePrefix}${agent.role}:snap-${Date.now()}`;
  const commit = await docker(['commit', name, tag]);
  if (commit.code !== 0) throw new Error(`docker commit failed: ${commit.stderr.trim()}`);
  return createSnapshot({
    id: randomUUID(),
    role: agent.role,
    name: agent.name,
    imageTag: tag,
    instructions: agent.instructions,
    skills: agent.skills,
    notes,
  });
}

/** Defaults (model/budget/template) for a role, used when spawning from a snapshot. */
export function templateForRole(role: AgentRole) {
  return AGENT_TEMPLATES.find((t) => t.role === role) ?? AGENT_TEMPLATES[0];
}

// ---------------------------------------------------------------------------
// Learning (post-task self-improvement; auto-applied with history)
// ---------------------------------------------------------------------------

/** Resolve the agent's Claude Code credential, or null if none is configured. */
function claudeCreds(): { env: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY'; token: string } | null {
  const conn = getProviderConnection('claude-code');
  if (conn?.method === 'subscription') return { env: 'CLAUDE_CODE_OAUTH_TOKEN', token: conn.token };
  if (conn?.method === 'api-key') return { env: 'ANTHROPIC_API_KEY', token: conn.token };
  if (config.anthropicKey) return { env: 'ANTHROPIC_API_KEY', token: config.anthropicKey };
  return null;
}

/** Sync eligibility gate for reflection (so we can claim the agent atomically). */
function reflectionEligible(agent: DeployedAgent): boolean {
  return (
    agent.learningEnabled &&
    agent.provider === 'claude-code' &&
    !config.dryRun &&
    agent.status === 'idle' &&
    claudeCreds() !== null
  );
}

function buildReflectionPrompt(
  agent: DeployedAgent,
  outcome: string,
  feedback: string | undefined,
  transcript: string,
): string {
  const memoryNote = isMemoryEnabled() && getConduitConfig()?.url
    ? 'If the conduit memory tools are available, also call `remember` exactly once to store a durable, shared lesson from this task.\n'
    : '';
  return [
    `You are improving your own operating instructions as an autonomous ${agent.role} agent.`,
    '',
    'Below are your CURRENT instructions, a transcript of a task you just completed,',
    'its outcome, and any human feedback. Reflect briefly, then produce improved',
    'instructions that would make you do better next time. Keep them concise and',
    'GENERAL (not specific to this one task). Preserve what works; change only what',
    'the evidence supports.',
    memoryNote,
    'Output EXACTLY this format and nothing else:',
    '::summary:: <one line describing what you changed>',
    '::instructions-begin::',
    '<the full improved instructions>',
    '::instructions-end::',
    '',
    '=== CURRENT INSTRUCTIONS ===',
    agent.instructions,
    '',
    '=== OUTCOME ===',
    outcome,
    ...(feedback ? ['', '=== HUMAN FEEDBACK ===', feedback] : []),
    '',
    '=== TASK TRANSCRIPT (truncated) ===',
    transcript,
  ].join('\n');
}

/**
 * Synchronously claim an eligible agent, then reflect asynchronously. The claim
 * (status -> running) happens in this tick so the dispatcher can't pick the agent
 * while it reflects. Best-effort: never throws into the caller's lifecycle.
 */
function kickReflection(agentId: string, runId: string, outcome: string, feedback?: string): void {
  const agent = getAgent(agentId);
  if (!agent || !reflectionEligible(agent)) return;
  updateAgent(agentId, { status: 'running' }); // atomic claim within this tick
  void runReflection(agent, runId, outcome, feedback);
}

async function runReflection(
  agent: DeployedAgent,
  runId: string,
  outcome: string,
  feedback: string | undefined,
): Promise<void> {
  const name = agentContainerName(agent.id);
  try {
    emit(runId, 'system', 'reflecting on this run to improve instructions…');
    const transcript = listLogs(runId, 500)
      .map((l) => `[${l.stream}] ${l.content}`)
      .join('\n')
      .slice(-12_000);

    const env: Record<string, string> = {
      REFLECT_PROMPT: buildReflectionPrompt(agent, outcome, feedback, transcript),
      MODEL_ID: agent.model,
      PROVIDER: agent.provider,
    };
    const creds = claudeCreds();
    if (creds) env[creds.env] = creds.token;
    if (isMemoryEnabled()) {
      const conduit = getConduitConfig();
      if (conduit?.url) {
        env.CONDUIT_MCP_URL = conduit.url;
        if (conduit.apiKey) env.CONDUIT_API_KEY = conduit.apiKey;
      }
    }

    await ensureAgentContainer(agent);
    const args = ['exec'];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(name, '/usr/local/bin/reflect-task.sh');
    const res = await docker(args);

    const block = res.stdout.match(/::instructions-begin::\n?([\s\S]*?)\n?::instructions-end::/);
    const summary = res.stdout.match(/::summary::(.*)/)?.[1]?.trim() || 'self-improvement after a run';
    if (!block) {
      emit(runId, 'system', 'reflection returned no structured update');
      return;
    }
    const next = block[1].trim();
    if (!next || next === agent.instructions.trim()) {
      emit(runId, 'system', 'reflection produced no instruction change');
      return;
    }
    // Auto-apply, keeping a history entry for rollback.
    recordLearning({
      agentId: agent.id,
      beforeInstructions: agent.instructions,
      afterInstructions: next,
      beforeSkills: agent.skills,
      afterSkills: agent.skills,
      summary,
      sourceRunId: runId,
    });
    updateAgent(agent.id, { instructions: next });
    emit(runId, 'system', `learned: ${summary}`);
  } catch (err) {
    emit(runId, 'system', `reflection failed: ${String(err)}`);
  } finally {
    // Capture any self-update the reflection made before releasing the agent.
    await autoCommitIfChanged(agent.id);
    // Release the agent (it was claimed for reflection, not a real run).
    if (getAgent(agent.id)?.status === 'running' && !agentHasRunningRun(agent.id)) {
      updateAgent(agent.id, { status: 'idle' });
    }
    touchContainer(name);
  }
}

/**
 * Trigger reflection after a human decides an item's gate — the strongest signal,
 * since it carries the approve/reject decision and any comment. Reflects the agent
 * that produced the item's most recent run. Best-effort; safe to call and forget.
 */
export function reflectOnApproval(opts: {
  repo: string;
  issueNumber: number;
  decision: 'approved' | 'rejected';
  comment?: string;
}): void {
  const run = latestRunForItem(opts.repo, opts.issueNumber);
  if (!run) return;
  const agentId = run.id.split(':')[0];
  const feedback = `Your work was ${opts.decision} by the human reviewer.${
    opts.comment ? ` Comment: ${opts.comment}` : ''
  }`;
  kickReflection(agentId, run.id, `human ${opts.decision}`, feedback);
}
