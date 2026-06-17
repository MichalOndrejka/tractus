import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Approval,
  BudgetStatus,
  DeployedAgent,
  LogLine,
  Project,
  Run,
} from '@tractus/shared';
import { config } from './config.js';

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db: Database.Database = new Database(config.databasePath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS run (
    id           TEXT PRIMARY KEY,
    repo         TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    role         TEXT NOT NULL,
    model        TEXT NOT NULL,
    status       TEXT NOT NULL,
    branch       TEXT,
    pr_url       TEXT,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    cost_usd     REAL NOT NULL DEFAULT 0,
    exit_reason  TEXT
  );

  CREATE TABLE IF NOT EXISTS log_line (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL,
    ts      TEXT NOT NULL,
    stream  TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_log_run ON log_line(run_id);

  CREATE TABLE IF NOT EXISTS approval (
    id           TEXT PRIMARY KEY,
    repo         TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    gate         TEXT NOT NULL,
    state        TEXT NOT NULL,
    comment      TEXT,
    created_at   TEXT NOT NULL,
    decided_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS budget_ledger (
    day        TEXT PRIMARY KEY,
    tokens_in  INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd   REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);

  CREATE TABLE IF NOT EXISTS project (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    repo           TEXT NOT NULL,
    default_branch TEXT,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS item_position (
    project_id   TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    position     REAL NOT NULL,
    PRIMARY KEY (project_id, issue_number)
  );

  CREATE TABLE IF NOT EXISTS agent (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL,
    template_id      TEXT NOT NULL,
    role             TEXT NOT NULL,
    name             TEXT NOT NULL,
    model            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'idle',
    daily_budget_usd REAL NOT NULL DEFAULT 0,
    instructions     TEXT NOT NULL DEFAULT '',
    skills           TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_project ON agent(project_id);

  CREATE TABLE IF NOT EXISTS event (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    from_state TEXT,
    to_state   TEXT,
    actor      TEXT NOT NULL,
    ts         TEXT NOT NULL,
    payload    TEXT
  );
`);

// --- lightweight migrations (add columns to pre-existing tables) -----------

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('project', 'default_branch', 'default_branch TEXT');
ensureColumn('agent', 'instructions', "instructions TEXT NOT NULL DEFAULT ''");
ensureColumn('agent', 'skills', "skills TEXT NOT NULL DEFAULT '[]'");
ensureColumn('agent', 'provider', "provider TEXT NOT NULL DEFAULT 'claude-code'");

// Migrate legacy model-tier values ('sonnet'/'haiku'/'opus') -> concrete ids.
for (const [tier, id] of Object.entries({
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
})) {
  db.prepare('UPDATE agent SET model = ? WHERE model = ?').run(id, tier);
}

// --- row mappers ----------------------------------------------------------

interface RunRow {
  id: string;
  repo: string;
  issue_number: number;
  role: string;
  model: string;
  status: string;
  branch: string | null;
  pr_url: string | null;
  started_at: string;
  ended_at: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  exit_reason: string | null;
}

function mapRun(r: RunRow): Run {
  return {
    id: r.id,
    repo: r.repo,
    issueNumber: r.issue_number,
    role: r.role as Run['role'],
    model: r.model as Run['model'],
    status: r.status as Run['status'],
    branch: r.branch ?? undefined,
    prUrl: r.pr_url ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    exitReason: r.exit_reason ?? undefined,
  };
}

// --- queries ---------------------------------------------------------------

export function listRuns(limit = 50): Run[] {
  const rows = db
    .prepare('SELECT * FROM run ORDER BY started_at DESC LIMIT ?')
    .all(limit) as RunRow[];
  return rows.map(mapRun);
}

export function getRun(id: string): Run | undefined {
  const row = db.prepare('SELECT * FROM run WHERE id = ?').get(id) as RunRow | undefined;
  return row ? mapRun(row) : undefined;
}

/** Currently-running runs for a repo (used to show the active agent on a card). */
export function listActiveRuns(repo: string): Run[] {
  const rows = db
    .prepare("SELECT * FROM run WHERE repo = ? AND status = 'running' ORDER BY started_at DESC")
    .all(repo) as RunRow[];
  return rows.map(mapRun);
}

export function countRunningRuns(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM run WHERE status = 'running'").get() as {
    n: number;
  }).n;
}

/** All runs still marked running (any repo) — used by startup reconciliation. */
export function listRunningRuns(): Run[] {
  const rows = db
    .prepare("SELECT * FROM run WHERE status = 'running' ORDER BY started_at ASC")
    .all() as RunRow[];
  return rows.map(mapRun);
}

export function createRun(input: {
  id: string;
  repo: string;
  issueNumber: number;
  role: string;
  model: string;
}): Run {
  const startedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO run(id, repo, issue_number, role, model, status, started_at, tokens_in, tokens_out, cost_usd)
     VALUES(?, ?, ?, ?, ?, 'running', ?, 0, 0, 0)`,
  ).run(input.id, input.repo, input.issueNumber, input.role, input.model, startedAt);
  return getRun(input.id)!;
}

export function addLog(runId: string, stream: LogLine['stream'], content: string): LogLine {
  const ts = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO log_line(run_id, ts, stream, content) VALUES(?, ?, ?, ?)')
    .run(runId, ts, stream, content);
  return { id: Number(info.lastInsertRowid), runId, ts, stream, content };
}

export function finishRun(
  id: string,
  status: Run['status'],
  fields: {
    exitReason?: string;
    prUrl?: string;
    costUsd?: number;
    tokensIn?: number;
    tokensOut?: number;
  } = {},
): Run | undefined {
  const existing = getRun(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE run SET status = ?, ended_at = ?, exit_reason = ?, pr_url = ?, cost_usd = ?, tokens_in = ?, tokens_out = ? WHERE id = ?`,
  ).run(
    status,
    new Date().toISOString(),
    fields.exitReason ?? null,
    fields.prUrl ?? existing.prUrl ?? null,
    fields.costUsd ?? existing.costUsd,
    fields.tokensIn ?? existing.tokensIn,
    fields.tokensOut ?? existing.tokensOut,
    id,
  );
  return getRun(id);
}

/** Consecutive failed/killed runs on an item since its last successful run. */
export function recentFailureStreak(repo: string, issueNumber: number): number {
  const rows = db
    .prepare(
      "SELECT status FROM run WHERE repo = ? AND issue_number = ? AND status IN ('done','failed','killed') ORDER BY started_at DESC",
    )
    .all(repo, issueNumber) as Array<{ status: string }>;
  let streak = 0;
  for (const r of rows) {
    if (r.status === 'done') break;
    streak += 1;
  }
  return streak;
}

/** Has an agent of this role already completed a run on the item? */
export function hasCompletedRunForRole(repo: string, issueNumber: number, role: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM run WHERE repo = ? AND issue_number = ? AND role = ? AND status = 'done' LIMIT 1",
    )
    .get(repo, issueNumber, role);
  return Boolean(row);
}

/** Most recent PR URL produced for an item, if any. */
export function latestPrUrlForItem(repo: string, issueNumber: number): string | undefined {
  const row = db
    .prepare(
      'SELECT pr_url FROM run WHERE repo = ? AND issue_number = ? AND pr_url IS NOT NULL ORDER BY started_at DESC LIMIT 1',
    )
    .get(repo, issueNumber) as { pr_url: string | null } | undefined;
  return row?.pr_url ?? undefined;
}

/** Add a run's usage to today's budget ledger (drives the breaker). */
export function addBudgetCost(tokensIn: number, tokensOut: number, costUsd: number): void {
  if (!tokensIn && !tokensOut && !costUsd) return;
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO budget_ledger(day, tokens_in, tokens_out, cost_usd) VALUES(?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       tokens_in = tokens_in + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out,
       cost_usd = cost_usd + excluded.cost_usd`,
  ).run(day, tokensIn, tokensOut, costUsd);
}

export function listLogs(runId: string, limit = 500): LogLine[] {
  const rows = db
    .prepare('SELECT * FROM log_line WHERE run_id = ? ORDER BY id ASC LIMIT ?')
    .all(runId, limit) as Array<{
    id: number;
    run_id: string;
    ts: string;
    stream: string;
    content: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    ts: r.ts,
    stream: r.stream as LogLine['stream'],
    content: r.content,
  }));
}

export function listApprovals(state?: Approval['state']): Approval[] {
  const rows = (
    state
      ? db.prepare('SELECT * FROM approval WHERE state = ? ORDER BY created_at DESC').all(state)
      : db.prepare('SELECT * FROM approval ORDER BY created_at DESC').all()
  ) as Array<{
    id: string;
    repo: string;
    issue_number: number;
    gate: string;
    state: string;
    comment: string | null;
    created_at: string;
    decided_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    issueNumber: r.issue_number,
    gate: r.gate as Approval['gate'],
    state: r.state as Approval['state'],
    comment: r.comment ?? undefined,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? undefined,
  }));
}

interface ApprovalRow {
  id: string;
  repo: string;
  issue_number: number;
  gate: string;
  state: string;
  comment: string | null;
  created_at: string;
  decided_at: string | null;
}

function mapApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    repo: r.repo,
    issueNumber: r.issue_number,
    gate: r.gate as Approval['gate'],
    state: r.state as Approval['state'],
    comment: r.comment ?? undefined,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? undefined,
  };
}

export function getApproval(id: string): Approval | undefined {
  const row = db.prepare('SELECT * FROM approval WHERE id = ?').get(id) as ApprovalRow | undefined;
  return row ? mapApproval(row) : undefined;
}

/** Open a pending approval gate for an item; reuses an existing pending one. */
export function createApproval(input: {
  repo: string;
  issueNumber: number;
  gate: Approval['gate'];
}): Approval {
  const existing = db
    .prepare(
      "SELECT * FROM approval WHERE repo = ? AND issue_number = ? AND gate = ? AND state = 'pending'",
    )
    .get(input.repo, input.issueNumber, input.gate) as ApprovalRow | undefined;
  if (existing) return mapApproval(existing);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO approval(id, repo, issue_number, gate, state, created_at) VALUES(?, ?, ?, ?, 'pending', ?)",
  ).run(id, input.repo, input.issueNumber, input.gate, createdAt);
  return getApproval(id)!;
}

export function decideApproval(
  id: string,
  state: 'approved' | 'rejected',
  comment?: string,
): Approval | undefined {
  const existing = getApproval(id);
  if (!existing) return undefined;
  db.prepare('UPDATE approval SET state = ?, comment = ?, decided_at = ? WHERE id = ?').run(
    state,
    comment ?? null,
    new Date().toISOString(),
    id,
  );
  return getApproval(id);
}

/** True once an item's plan (Gate 1) has been approved — used to route the
 *  next pickup to the Developer instead of the Architect. */
export function hasApprovedPlan(repo: string, issueNumber: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM approval WHERE repo = ? AND issue_number = ? AND gate = 'plan' AND state = 'approved' LIMIT 1",
    )
    .get(repo, issueNumber);
  return Boolean(row);
}

/** The most recent pending approval for an item, if any. */
export function pendingApprovalFor(repo: string, issueNumber: number): Approval | undefined {
  const row = db
    .prepare(
      "SELECT * FROM approval WHERE repo = ? AND issue_number = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1",
    )
    .get(repo, issueNumber) as ApprovalRow | undefined;
  return row ? mapApproval(row) : undefined;
}

// --- app_state key/value ---------------------------------------------------

export function getState(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  db.prepare(
    'INSERT INTO app_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function deleteState(key: string): void {
  db.prepare('DELETE FROM app_state WHERE key = ?').run(key);
}

// --- GitHub connection token (stored locally; never returned via API) -------

const GH_TOKEN_KEY = 'github_token';
export const getGithubToken = () => getState(GH_TOKEN_KEY);
export const setGithubToken = (token: string) => setState(GH_TOKEN_KEY, token);
export const clearGithubToken = () => deleteState(GH_TOKEN_KEY);

// --- provider connections (agentic system credentials; never returned) ------

export interface StoredProviderConnection {
  method: 'subscription' | 'api-key';
  token: string;
}

const providerKey = (id: string) => `provider_conn:${id}`;

export function getProviderConnection(id: string): StoredProviderConnection | undefined {
  const raw = getState(providerKey(id));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StoredProviderConnection;
  } catch {
    return undefined;
  }
}

export function setProviderConnection(id: string, conn: StoredProviderConnection): void {
  setState(providerKey(id), JSON.stringify(conn));
}

export function clearProviderConnection(id: string): void {
  deleteState(providerKey(id));
}

// --- projects --------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  repo: string;
  default_branch: string | null;
  created_at: string;
}

function mapProject(r: ProjectRow): Project {
  const agentCount = (
    db.prepare('SELECT COUNT(*) AS n FROM agent WHERE project_id = ?').get(r.id) as { n: number }
  ).n;
  return {
    id: r.id,
    name: r.name,
    repo: r.repo,
    defaultBranch: r.default_branch ?? undefined,
    createdAt: r.created_at,
    agentCount,
  };
}

export function listProjects(): Project[] {
  const rows = db.prepare('SELECT * FROM project ORDER BY created_at DESC').all() as ProjectRow[];
  return rows.map(mapProject);
}

export function getProject(id: string): Project | undefined {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? mapProject(row) : undefined;
}

export function createProject(input: {
  name: string;
  repo: string;
  defaultBranch?: string;
}): Project {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO project(id, name, repo, default_branch, created_at) VALUES(?, ?, ?, ?, ?)',
  ).run(id, input.name, input.repo, input.defaultBranch ?? null, createdAt);
  return {
    id,
    name: input.name,
    repo: input.repo,
    defaultBranch: input.defaultBranch,
    createdAt,
    agentCount: 0,
  };
}

export function deleteProject(id: string): void {
  db.prepare('DELETE FROM agent WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM project WHERE id = ?').run(id);
}

// --- work-item ordering (local; GitHub has no native order) ----------------

export function getPositions(projectId: string): Map<number, number> {
  const rows = db
    .prepare('SELECT issue_number, position FROM item_position WHERE project_id = ?')
    .all(projectId) as Array<{ issue_number: number; position: number }>;
  return new Map(rows.map((r) => [r.issue_number, r.position]));
}

/** Persist an explicit ordering for the given issue numbers (position = index). */
export function setOrder(projectId: string, numbers: number[]): void {
  const stmt = db.prepare(
    `INSERT INTO item_position(project_id, issue_number, position) VALUES(?, ?, ?)
     ON CONFLICT(project_id, issue_number) DO UPDATE SET position = excluded.position`,
  );
  const tx = db.transaction((nums: number[]) => {
    nums.forEach((n, i) => stmt.run(projectId, n, i));
  });
  tx(numbers);
}

// --- agents ----------------------------------------------------------------

interface AgentRow {
  id: string;
  project_id: string;
  template_id: string;
  role: string;
  name: string;
  provider: string;
  model: string;
  status: string;
  daily_budget_usd: number;
  instructions: string;
  skills: string;
  created_at: string;
}

function spentTodayForAgent(agentId: string): number {
  const day = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM run WHERE id LIKE ? AND substr(started_at, 1, 10) = ?",
    )
    .get(`${agentId}:%`, day) as { c: number };
  return row.c;
}

function mapAgent(r: AgentRow): DeployedAgent {
  let skills: DeployedAgent['skills'] = [];
  try {
    skills = JSON.parse(r.skills || '[]');
  } catch {
    skills = [];
  }
  return {
    id: r.id,
    projectId: r.project_id,
    templateId: r.template_id,
    role: r.role as DeployedAgent['role'],
    name: r.name,
    provider: (r.provider || 'claude-code') as DeployedAgent['provider'],
    model: r.model,
    status: r.status as DeployedAgent['status'],
    dailyBudgetUsd: r.daily_budget_usd,
    spentTodayUsd: spentTodayForAgent(r.id),
    instructions: r.instructions ?? '',
    skills,
    createdAt: r.created_at,
  };
}

export function listAgents(projectId: string): DeployedAgent[] {
  const rows = db
    .prepare('SELECT * FROM agent WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as AgentRow[];
  return rows.map(mapAgent);
}

export function getAgent(id: string): DeployedAgent | undefined {
  const row = db.prepare('SELECT * FROM agent WHERE id = ?').get(id) as AgentRow | undefined;
  return row ? mapAgent(row) : undefined;
}

export function createAgent(input: {
  projectId: string;
  templateId: string;
  role: string;
  name: string;
  provider: string;
  model: string;
  dailyBudgetUsd: number;
  instructions: string;
  skills: DeployedAgent['skills'];
}): DeployedAgent {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent(id, project_id, template_id, role, name, provider, model, status, daily_budget_usd, instructions, skills, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.templateId,
    input.role,
    input.name,
    input.provider,
    input.model,
    input.dailyBudgetUsd,
    input.instructions,
    JSON.stringify(input.skills ?? []),
    createdAt,
  );
  return getAgent(id)!;
}

export function updateAgent(
  id: string,
  patch: {
    dailyBudgetUsd?: number;
    status?: string;
    name?: string;
    provider?: string;
    model?: string;
    instructions?: string;
    skills?: DeployedAgent['skills'];
  },
): DeployedAgent | undefined {
  const existing = getAgent(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE agent SET daily_budget_usd = ?, status = ?, name = ?, provider = ?, model = ?, instructions = ?, skills = ?
     WHERE id = ?`,
  ).run(
    patch.dailyBudgetUsd ?? existing.dailyBudgetUsd,
    patch.status ?? existing.status,
    patch.name ?? existing.name,
    patch.provider ?? existing.provider,
    patch.model ?? existing.model,
    patch.instructions ?? existing.instructions,
    JSON.stringify(patch.skills ?? existing.skills),
    id,
  );
  return getAgent(id);
}

export function deleteAgent(id: string): void {
  db.prepare('DELETE FROM agent WHERE id = ?').run(id);
}

function getFlag(key: string): boolean {
  return getState(key) === 'true';
}

export function getBudgetStatus(runningAgents: number): BudgetStatus {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT * FROM budget_ledger WHERE day = ?').get(day) as
    | { day: string; tokens_in: number; tokens_out: number; cost_usd: number }
    | undefined;
  return {
    day,
    tokensIn: row?.tokens_in ?? 0,
    tokensOut: row?.tokens_out ?? 0,
    costUsd: row?.cost_usd ?? 0,
    dailyLimitUsd: config.budget.dailyLimitUsd,
    dispatchPaused: getFlag('dispatch_paused'),
    runningAgents,
    concurrencyLimit: config.budget.concurrencyLimit,
  };
}
