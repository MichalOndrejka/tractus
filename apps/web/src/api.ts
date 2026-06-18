import type {
  Approval,
  AgentContainerStatus,
  AgentLearning,
  AgentSnapshot,
  AgentTemplate,
  ConduitStatus,
  BacklogItem,
  BacklogItemType,
  BacklogState,
  BudgetStatus,
  DeployedAgent,
  GitHubConnection,
  GitHubRepoOption,
  LogLine,
  Project,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderInfo,
  Run,
  Skill,
  WsEvent,
} from '@tractus/shared';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string }).error || `${path} -> ${res.status}`);
  return data;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  user?: { email: string };
}

export const api = {
  // auth
  authStatus: () => req<AuthStatus>('/api/auth/status'),
  signup: (email: string, password: string) =>
    req<AuthStatus>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    req<AuthStatus>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req<AuthStatus>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }),

  // connection
  connection: () => req<GitHubConnection & { error?: string }>('/api/connection'),
  connect: (token: string) =>
    req<GitHubConnection>('/api/connection', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnect: () => req<GitHubConnection>('/api/connection', { method: 'DELETE' }),
  repos: () => req<{ repos: GitHubRepoOption[] }>('/api/github/repos'),

  // providers (agentic systems)
  providers: () =>
    req<{ providers: ProviderInfo[]; connections: ProviderConnection[] }>('/api/providers'),
  connectProvider: (id: string, method: ProviderAuthMethod, token: string) =>
    req<{ connection: ProviderConnection }>(`/api/providers/${id}/connection`, {
      method: 'POST',
      body: JSON.stringify({ method, token }),
    }),
  disconnectProvider: (id: string) =>
    req<{ connection: ProviderConnection }>(`/api/providers/${id}/connection`, { method: 'DELETE' }),

  // conduit (shared memory over MCP)
  conduit: () => req<ConduitStatus>('/api/conduit'),
  saveConduit: (input: { url?: string; apiKey?: string; memoryEnabled?: boolean }) =>
    req<ConduitStatus>('/api/conduit', { method: 'PUT', body: JSON.stringify(input) }),
  disconnectConduit: () => req<ConduitStatus>('/api/conduit', { method: 'DELETE' }),

  // projects
  projects: () => req<{ projects: Project[] }>('/api/projects'),
  project: (id: string) => req<{ project: Project }>(`/api/projects/${id}`),
  createProject: (input: {
    name: string;
    repo: string;
    defaultBranch?: string;
  }) =>
    req<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteProject: (id: string) => req<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // backlog / issues
  backlog: (projectId: string) =>
    req<{ items: BacklogItem[] }>(`/api/projects/${projectId}/backlog`),
  createIssue: (
    projectId: string,
    input: { title: string; body?: string; type?: BacklogItemType; priority?: number },
  ) =>
    req<{ item: BacklogItem }>(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateIssue: (
    projectId: string,
    number: number,
    patch: { state?: BacklogState; priority?: number; type?: BacklogItemType; title?: string; body?: string },
  ) =>
    req<{ item: BacklogItem }>(`/api/projects/${projectId}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteIssue: (projectId: string, number: number) =>
    req<{ ok: true }>(`/api/projects/${projectId}/issues/${number}`, { method: 'DELETE' }),
  setOrder: (projectId: string, numbers: number[]) =>
    req<{ ok: true }>(`/api/projects/${projectId}/order`, {
      method: 'PUT',
      body: JSON.stringify({ numbers }),
    }),

  // agents
  templates: () => req<{ templates: AgentTemplate[] }>('/api/agent-templates'),
  agents: (projectId: string) =>
    req<{ agents: DeployedAgent[] }>(`/api/projects/${projectId}/agents`),
  deployAgent: (
    projectId: string,
    payload: {
      templateId: string;
      name?: string;
      provider?: string;
      model?: string;
      dailyBudgetUsd?: number;
      instructions?: string;
      skills?: Skill[];
    },
  ) =>
    req<{ agent: DeployedAgent }>(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  agent: (agentId: string) => req<{ agent: DeployedAgent }>(`/api/agents/${agentId}`),
  updateAgent: (
    agentId: string,
    patch: {
      dailyBudgetUsd?: number;
      status?: string;
      name?: string;
      provider?: string;
      model?: string;
      instructions?: string;
      skills?: Skill[];
      learningEnabled?: boolean;
    },
  ) =>
    req<{ agent: DeployedAgent }>(`/api/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteAgent: (agentId: string) =>
    req<{ ok: true }>(`/api/agents/${agentId}`, { method: 'DELETE' }),
  agentRuns: (agentId: string) => req<{ runs: Run[] }>(`/api/agents/${agentId}/runs`),
  runAgent: (agentId: string, workItemNumber: number) =>
    req<{ run: Run }>(`/api/agents/${agentId}/run`, {
      method: 'POST',
      body: JSON.stringify({ workItemNumber }),
    }),

  // persistent container (per agent)
  container: (agentId: string) =>
    req<{ container: AgentContainerStatus }>(`/api/agents/${agentId}/container`),
  startContainer: (agentId: string) =>
    req<{ container: AgentContainerStatus }>(`/api/agents/${agentId}/container/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  stopContainer: (agentId: string) =>
    req<{ container: AgentContainerStatus }>(`/api/agents/${agentId}/container/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // snapshots (capture a trained agent, then multiply)
  snapshots: () => req<{ snapshots: AgentSnapshot[] }>('/api/snapshots'),
  snapshotAgent: (agentId: string, notes?: string) =>
    req<{ snapshot: AgentSnapshot }>(`/api/agents/${agentId}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ notes }),
    }),
  spawnFromSnapshot: (snapshotId: string, projectId: string, count: number) =>
    req<{ agents: DeployedAgent[] }>(`/api/snapshots/${snapshotId}/spawn`, {
      method: 'POST',
      body: JSON.stringify({ projectId, count }),
    }),
  deleteSnapshot: (snapshotId: string) =>
    req<{ ok: true }>(`/api/snapshots/${snapshotId}`, { method: 'DELETE' }),

  // learning (self-improvement history)
  learning: (agentId: string) =>
    req<{ learning: AgentLearning[] }>(`/api/agents/${agentId}/learning`),
  rollbackLearning: (agentId: string, entryId: string) =>
    req<{ agent: DeployedAgent }>(`/api/agents/${agentId}/learning/${entryId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // shared
  logs: (runId: string) => req<{ logs: LogLine[] }>(`/api/runs/${runId}/logs`),
  approvals: (state?: string) =>
    req<{ approvals: Approval[] }>(`/api/approvals${state ? `?state=${state}` : ''}`),
  decideApproval: (id: string, decision: 'approved' | 'rejected', comment?: string) =>
    req<{ approval: Approval }>(`/api/approvals/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    }),
  budget: () => req<{ budget: BudgetStatus }>('/api/budget'),
};

// ---------------------------------------------------------------------------
// Live event stream — a SINGLE shared WebSocket multiplexed to all subscribers.
//
// Every component that wants live updates (the app-shell live-dot, the board,
// the agent page) subscribes to this one socket instead of opening its own.
// Subscribers are reference-counted; when the last one leaves we close after a
// short grace period, so React StrictMode's mount→unmount→remount and ordinary
// page navigation don't actually drop and reopen the connection (which is what
// produced the /ws churn + "write ECONNABORTED" proxy noise).
// ---------------------------------------------------------------------------

type EventHandler = (e: WsEvent) => void;
type StatusHandler = (live: boolean) => void;

const eventHandlers = new Set<EventHandler>();
const statusHandlers = new Set<StatusHandler>();
let sharedSocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let isLive = false;

function setLive(live: boolean): void {
  isLive = live;
  statusHandlers.forEach((h) => h(live));
}

function openSharedSocket(): void {
  if (
    sharedSocket &&
    (sharedSocket.readyState === WebSocket.OPEN || sharedSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  sharedSocket = socket;
  socket.onopen = () => setLive(true);
  socket.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data && typeof data.type === 'string' && data.type !== 'hello') {
        eventHandlers.forEach((h) => h(data as WsEvent));
      }
    } catch {
      /* ignore malformed frames */
    }
  };
  const onDown = () => {
    if (sharedSocket !== socket) return; // superseded by a newer socket
    sharedSocket = null;
    setLive(false);
    // Reconnect only while something is still listening.
    if (eventHandlers.size > 0 || statusHandlers.size > 0) {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(openSharedSocket, 2000);
    }
  };
  socket.onclose = onDown;
  socket.onerror = onDown;
}

function scheduleCloseIfIdle(): void {
  if (eventHandlers.size > 0 || statusHandlers.size > 0) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (eventHandlers.size > 0 || statusHandlers.size > 0) return; // someone came back
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sharedSocket) {
      const s = sharedSocket;
      sharedSocket = null;
      s.onclose = null;
      s.onerror = null;
      s.close();
    }
  }, 1500); // grace period absorbs StrictMode churn + navigation
}

/** Subscribe to the shared live event stream. Returns a disposer. */
export function connectWs(onEvent: EventHandler, onStatus: StatusHandler) {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  eventHandlers.add(onEvent);
  statusHandlers.add(onStatus);
  onStatus(isLive); // report current state immediately
  openSharedSocket();
  return () => {
    eventHandlers.delete(onEvent);
    statusHandlers.delete(onStatus);
    scheduleCloseIfIdle();
  };
}
