/**
 * Shared domain types for Tractus.
 *
 * The backlog lives in GitHub (Issues/Projects); these types describe the
 * *process* overlay we keep locally (state machine, runs, budget, approvals)
 * plus a normalized view of a backlog item for the UI.
 */

// ---------------------------------------------------------------------------
// Backlog state machine (overlaid on GitHub issue status via labels)
// ---------------------------------------------------------------------------

export const BACKLOG_STATES = [
  'BACKLOG',
  'PLANNING',
  'PLAN_READY',
  'READY',
  'IN_PROGRESS',
  'IN_TESTING',
  'IN_REVIEW',
  'DONE',
  'BLOCKED',
  'FAILED',
] as const;

export type BacklogState = (typeof BACKLOG_STATES)[number];

/** Allowed transitions for the backlog state machine. */
export const STATE_TRANSITIONS: Record<BacklogState, BacklogState[]> = {
  BACKLOG: ['PLANNING'],
  PLANNING: ['PLAN_READY', 'BLOCKED', 'FAILED'],
  PLAN_READY: ['READY', 'BACKLOG'], // gate 1: approve -> READY, reject -> BACKLOG
  READY: ['IN_PROGRESS'],
  IN_PROGRESS: ['IN_TESTING', 'BLOCKED', 'FAILED'],
  IN_TESTING: ['IN_REVIEW', 'IN_PROGRESS', 'BLOCKED'],
  IN_REVIEW: ['DONE', 'IN_PROGRESS'], // gate 2: approve -> DONE, reject -> IN_PROGRESS
  DONE: [],
  BLOCKED: ['BACKLOG', 'READY', 'IN_PROGRESS', 'FAILED'],
  FAILED: ['BACKLOG'],
};

export function canTransition(from: BacklogState, to: BacklogState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Agent roles & model tiers
// ---------------------------------------------------------------------------

export const AGENT_ROLES = ['architect', 'developer', 'tester', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const MODEL_TIERS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
} as const;
export type ModelTier = keyof typeof MODEL_TIERS;

/** Default model per role (escalation can bump these up a tier). */
export const ROLE_DEFAULT_MODEL: Record<AgentRole, ModelTier> = {
  architect: 'sonnet',
  developer: 'sonnet',
  tester: 'sonnet',
  reviewer: 'haiku',
};

// ---------------------------------------------------------------------------
// Agentic system providers (the CLI/system that runs inside the container)
// ---------------------------------------------------------------------------

export const AGENT_PROVIDERS = ['claude-code', 'codex'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export interface ProviderModel {
  /** Concrete model id passed to the provider CLI. */
  id: string;
  label: string;
}

/** How a provider authenticates (decides which secret/env the container needs). */
export type ProviderAuthMethod = 'subscription' | 'api-key';

export interface ProviderInfo {
  id: AgentProvider;
  name: string;
  blurb: string;
  /** CLI binary the container invokes. */
  cli: string;
  models: ProviderModel[];
  authMethods: ProviderAuthMethod[];
  /** False until the container image + run path support it. */
  available: boolean;
}

export const AGENT_PROVIDERS_INFO: ProviderInfo[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    blurb: "Anthropic's Claude Code CLI. Use your subscription (OAuth token) or a pay-as-you-go API key.",
    cli: 'claude',
    models: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced (recommended)' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — cheapest, fast' },
    ],
    authMethods: ['subscription', 'api-key'],
    available: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    blurb: "OpenAI's Codex CLI. Coming soon — not yet wired into the agent image.",
    cli: 'codex',
    models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }],
    authMethods: ['api-key'],
    available: false,
  },
];

export function providerInfo(id: AgentProvider): ProviderInfo {
  return AGENT_PROVIDERS_INFO.find((p) => p.id === id) ?? AGENT_PROVIDERS_INFO[0];
}

/** UI/status view of a provider connection (token itself is never returned). */
export interface ProviderConnection {
  id: AgentProvider;
  connected: boolean;
  method?: ProviderAuthMethod;
}

/**
 * Shared memory connection to conduit (the team's experience/RAG store, reached
 * over MCP). One shared pool across all agents. The API key is never returned.
 */
export interface ConduitStatus {
  connected: boolean;
  url?: string;
  hasKey: boolean;
  /** Global toggle; only has effect once conduit is connected. */
  memoryEnabled: boolean;
  /** Result of a live health probe, when the status came from a write. */
  healthy?: boolean;
}

// ---------------------------------------------------------------------------
// Agent templates (catalog) + deployed agents (per project)
// ---------------------------------------------------------------------------

/** A reusable capability prompt attached to an agent. */
export interface Skill {
  id: string;
  name: string;
  content: string;
}

export interface AgentTemplate {
  id: string;
  role: AgentRole;
  name: string;
  blurb: string;
  /** Default provider this template deploys with. */
  provider: AgentProvider;
  /** Default concrete model id (provider-specific). */
  model: string;
  defaultDailyBudgetUsd: number;
  /** Default "agent file" (system prompt) seeded when deploying this template. */
  instructions: string;
  /** Default skills seeded when deploying. */
  skills: Skill[];
}

/** Catalog of agents the user can deploy into a project. */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'architect',
    role: 'architect',
    name: 'Architect',
    blurb: 'Turns a work item into a plan, design and acceptance criteria. Cheap; gated by you.',
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    defaultDailyBudgetUsd: 3,
    instructions: `You are the Architect / Software Engineer for this project.

Given a work item, produce a concise, reviewable implementation plan:
- Approach and key design decisions
- Files/areas to change
- Acceptance criteria
- Risks and open questions

Do NOT write code. Keep plans small enough to ship in one pull request. Follow
the project's existing patterns. Output the plan for the Product Owner to approve
before any implementation begins.`,
    skills: [],
  },
  {
    id: 'developer',
    role: 'developer',
    name: 'Software Developer',
    blurb: 'Implements approved plans on a branch and opens a pull request.',
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    defaultDailyBudgetUsd: 5,
    instructions: `You are the Software Developer for this project.

Implement the approved plan on a feature branch:
- Follow the repo's existing structure, style and conventions
- Make minimal, focused changes that satisfy the acceptance criteria
- Keep the change reviewable; no unrelated refactors
- Open a pull request with a clear description linking the work item

Never push directly to the default branch.`,
    skills: [],
  },
  {
    id: 'tester',
    role: 'tester',
    name: 'Tester / QA',
    blurb: 'Writes and runs tests against the PR; reports pass/fail and files bugs.',
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    defaultDailyBudgetUsd: 3,
    instructions: `You are the Tester / QA for this project.

Given a pull request:
- Write and run tests covering the acceptance criteria and edge cases
- Report pass/fail clearly with evidence
- If something fails, file a precise bug with reproduction steps

Prefer the project's existing test framework and conventions.`,
    skills: [],
  },
  {
    id: 'reviewer',
    role: 'reviewer',
    name: 'Auto-Reviewer',
    blurb: 'Summarizes the diff and flags risks for your final review. Runs on Haiku.',
    provider: 'claude-code',
    model: 'claude-haiku-4-5-20251001',
    defaultDailyBudgetUsd: 1,
    instructions: `You are the Auto-Reviewer for this project.

Summarize the pull request diff for the Product Owner's final review:
- What changed, at a glance
- Risks, security concerns, and missing tests
- Anything that needs human judgement

Be concise. Do NOT approve or merge — that is the Product Owner's decision.`,
    skills: [],
  },
];

export type AgentStatus = 'idle' | 'running' | 'paused';

export interface DeployedAgent {
  id: string;
  projectId: string;
  templateId: string;
  role: AgentRole;
  name: string;
  provider: AgentProvider;
  /** Concrete provider-specific model id. */
  model: string;
  status: AgentStatus;
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  instructions: string;
  skills: Skill[];
  /** Docker image this agent's persistent container is created from. Empty = base image. */
  imageTag?: string;
  /** When true, the agent reflects after a task and rewrites its own instructions. Off by default. */
  learningEnabled: boolean;
  createdAt: string;
}

/** A recorded self-improvement: instructions/skills before vs after, for rollback. */
export interface AgentLearning {
  id: string;
  agentId: string;
  beforeInstructions: string;
  afterInstructions: string;
  beforeSkills: Skill[];
  afterSkills: Skill[];
  summary: string;
  sourceRunId?: string;
  createdAt: string;
}

export type ContainerState = 'running' | 'stopped' | 'absent';

/** Live status of an agent's persistent container. */
export interface AgentContainerStatus {
  agentId: string;
  name: string;
  state: ContainerState;
  image?: string;
}

/**
 * A stored, trained agent state captured from an efficient agent: a committed
 * container image (tooling) plus its instructions/skills. Spawn N copies from it.
 */
export interface AgentSnapshot {
  id: string;
  role: AgentRole;
  name: string;
  /** Committed Docker image tag holding the trained environment. */
  imageTag: string;
  instructions: string;
  skills: Skill[];
  notes?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Project + GitHub connection
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  repo: string; // "owner/name"
  defaultBranch?: string;
  createdAt: string;
  openItems?: number;
  agentCount?: number;
}

export interface GitHubConnection {
  connected: boolean;
  login?: string;
  name?: string;
}

export interface GitHubRepoOption {
  fullName: string; // "owner/name"
  private: boolean;
  description?: string;
  defaultBranch: string;
}

// ---------------------------------------------------------------------------
// Normalized backlog item (UI view, sourced from GitHub)
// ---------------------------------------------------------------------------

export type BacklogItemType = 'feature' | 'bug';

export interface BacklogItem {
  /** GitHub issue number. */
  number: number;
  repo: string; // "owner/name"
  title: string;
  body: string;
  type: BacklogItemType;
  state: BacklogState;
  priority: number; // 0 = none, 1 = low ... 4 = urgent
  assignedToBot: boolean;
  url: string;
  labels: string[];
  prUrl?: string;
  updatedAt: string; // ISO
  /** Local rank within the project; lower = higher priority. Undefined = unranked. */
  position?: number;
  /** The agent currently running on this item, if any (live, from runs). */
  activeAgent?: { role: AgentRole; agentName: string; runId: string };
  /** Pending approval gate for this item, if any (plan/merge awaiting decision). */
  pendingApproval?: Approval;
}

// ---------------------------------------------------------------------------
// Runs, logs, budget, approvals (local operational state, in SQLite)
// ---------------------------------------------------------------------------

export type RunStatus = 'running' | 'done' | 'failed' | 'killed';

export interface Run {
  id: string;
  repo: string;
  issueNumber: number;
  role: AgentRole;
  provider?: AgentProvider;
  model: string;
  status: RunStatus;
  branch?: string;
  prUrl?: string;
  startedAt: string;
  endedAt?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  exitReason?: string;
}

export type LogStream = 'stdout' | 'stderr' | 'tool' | 'system';

export interface LogLine {
  id: number;
  runId: string;
  ts: string;
  stream: LogStream;
  content: string;
}

export type ApprovalGate = 'plan' | 'merge';
export type ApprovalState = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  repo: string;
  issueNumber: number;
  gate: ApprovalGate;
  state: ApprovalState;
  comment?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface BudgetStatus {
  day: string; // YYYY-MM-DD
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  dailyLimitUsd: number;
  dispatchPaused: boolean;
  runningAgents: number;
  concurrencyLimit: number;
}

// ---------------------------------------------------------------------------
// WebSocket event envelope (backend -> frontend live updates)
// ---------------------------------------------------------------------------

export type WsEvent =
  | { type: 'log'; line: LogLine }
  | { type: 'run.updated'; run: Run }
  | { type: 'backlog.updated'; item: BacklogItem }
  | { type: 'budget.updated'; budget: BudgetStatus }
  | { type: 'approval.updated'; approval: Approval };
