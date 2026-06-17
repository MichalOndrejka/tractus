import { Octokit } from '@octokit/rest';
import type {
  BacklogItem,
  BacklogItemType,
  BacklogState,
  GitHubConnection,
  GitHubRepoOption,
} from '@tractus/shared';
import { priorityFromLabels, stateFromLabels, stateLabel, typeFromLabels } from './state.js';

function client(token: string): Octokit {
  return new Octokit({ auth: token });
}

function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split('/');
  return { owner, repo };
}

/** Validate a token by fetching the authenticated user. Throws if invalid. */
export async function validateToken(token: string): Promise<GitHubConnection> {
  const octokit = client(token);
  const { data } = await octokit.users.getAuthenticated();
  return { connected: true, login: data.login, name: data.name ?? undefined };
}

/** List repos the token can access (for the project picker). */
export async function listRepos(token: string): Promise<GitHubRepoOption[]> {
  const octokit = client(token);
  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: 'updated',
    affiliation: 'owner,collaborator,organization_member',
  });
  return repos.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    description: r.description ?? undefined,
    defaultBranch: r.default_branch ?? 'main',
  }));
}

function normalizeIssue(repo: string, issue: {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  updated_at: string;
  labels: Array<string | { name?: string }>;
}): BacklogItem {
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
  return {
    number: issue.number,
    repo,
    title: issue.title,
    body: issue.body ?? '',
    type: typeFromLabels(labels),
    state: stateFromLabels(labels),
    priority: priorityFromLabels(labels),
    assignedToBot: true,
    url: issue.html_url,
    labels,
    updatedAt: issue.updated_at,
  };
}

/** Fetch open issues for a repo, normalized and ordered by priority. */
export async function fetchIssues(token: string, repo: string): Promise<BacklogItem[]> {
  const octokit = client(token);
  const { owner, repo: name } = parseRepo(repo);
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo: name,
    state: 'open',
    per_page: 100,
  });
  const items = issues
    .filter((i) => !i.pull_request)
    .map((i) => normalizeIssue(repo, i));
  items.sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
  return items;
}

export async function createIssue(
  token: string,
  repo: string,
  input: { title: string; body?: string; type?: BacklogItemType; priority?: number },
): Promise<BacklogItem> {
  const octokit = client(token);
  const { owner, repo: name } = parseRepo(repo);
  const labels = labelsForAttributes({
    type: input.type,
    priority: input.priority,
    state: 'BACKLOG',
  });
  await ensureLabels(octokit, owner, name, labels);
  const { data } = await octokit.issues.create({
    owner,
    repo: name,
    title: input.title,
    body: input.body ?? '',
    labels,
  });
  return normalizeIssue(repo, data);
}

/** Update an issue's managed labels (state / priority / type) and open/closed. */
export async function updateIssue(
  token: string,
  repo: string,
  number: number,
  patch: { state?: BacklogState; priority?: number; type?: BacklogItemType },
): Promise<BacklogItem> {
  const octokit = client(token);
  const { owner, repo: name } = parseRepo(repo);

  const { data: current } = await octokit.issues.get({ owner, repo: name, issue_number: number });
  const existing = current.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? '')));

  // strip managed labels we're about to replace
  const kept = existing.filter(
    (l) =>
      !(patch.state !== undefined && l.startsWith('state:')) &&
      !(patch.priority !== undefined && l.startsWith('priority:')) &&
      !(patch.type !== undefined && l.startsWith('type:')),
  );
  const added = labelsForAttributes(patch);
  const next = Array.from(new Set([...kept, ...added]));
  await ensureLabels(octokit, owner, name, added);

  const { data } = await octokit.issues.update({
    owner,
    repo: name,
    issue_number: number,
    labels: next,
    state: patch.state === 'DONE' ? 'closed' : 'open',
  });
  return normalizeIssue(repo, data);
}

const PRIORITY_NAME: Record<number, string> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'urgent' };

function labelsForAttributes(attrs: {
  state?: BacklogState;
  priority?: number;
  type?: BacklogItemType;
}): string[] {
  const labels: string[] = [];
  if (attrs.state) labels.push(stateLabel(attrs.state));
  if (attrs.priority && PRIORITY_NAME[attrs.priority]) labels.push(`priority:${PRIORITY_NAME[attrs.priority]}`);
  if (attrs.type) labels.push(`type:${attrs.type}`);
  return labels;
}

const LABEL_COLORS: Record<string, string> = {
  state: '34f5c5',
  priority: 'f5c542',
  type: '8b8bf5',
};

/** Make sure each label exists in the repo (create on 404) so updates don't fail. */
async function ensureLabels(octokit: Octokit, owner: string, repo: string, labels: string[]): Promise<void> {
  for (const name of labels) {
    try {
      await octokit.issues.getLabel({ owner, repo, name });
    } catch {
      const prefix = name.split(':')[0];
      try {
        await octokit.issues.createLabel({
          owner,
          repo,
          name,
          color: LABEL_COLORS[prefix] ?? 'cccccc',
        });
      } catch {
        /* race or perms — setLabels will surface the real error */
      }
    }
  }
}
