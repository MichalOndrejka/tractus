import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GitHubConnection, GitHubRepoOption, Project } from '@tractus/shared';
import { Screen } from '../components/Screen.js';
import { Modal } from '../components/Modal.js';
import { api } from '../api.js';

// --------------------------------------------------------------------------
// Connect GitHub (modal)
// --------------------------------------------------------------------------

function ConnectModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (c: GitHubConnection) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const connect = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      onConnected(await api.connect(token.trim()));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect GitHub" onClose={onClose}>
      <p className="muted small" style={{ lineHeight: 1.6, marginTop: 0 }}>
        Paste a Personal Access Token with <code>repo</code> + <code>issues</code> scope. It's
        stored locally and never leaves your machine. One-click OAuth can be added later once a
        GitHub OAuth App is registered.
      </p>
      <div className="field">
        <label>Personal Access Token</label>
        <input
          type="password"
          placeholder="ghp_… or github_pat_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token && connect()}
          autoFocus
        />
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="row between">
        <a className="btn sm" href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">
          create a token ↗
        </a>
        <button className="btn primary" disabled={!token || busy} onClick={connect}>
          {busy ? 'verifying…' : 'Connect'}
        </button>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------
// Add project — step 1: pick repo, step 2: details form
// --------------------------------------------------------------------------

function AddProjectModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (p: Project) => void;
}) {
  const [repos, setRepos] = useState<GitHubRepoOption[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();
  const [selected, setSelected] = useState<GitHubRepoOption>();

  // form fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .repos()
      .then((r) => setRepos(r.repos))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, []);

  const pick = (repo: GitHubRepoOption) => {
    setSelected(repo);
    setName(repo.fullName.split('/')[1]);
    setDescription(repo.description ?? '');
    setBranch(repo.defaultBranch);
  };

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setErr(undefined);
    try {
      const { project } = await api.createProject({
        name: name.trim() || selected.fullName,
        repo: selected.fullName,
        description,
        defaultBranch: branch,
      });
      onAdded(project);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const shown = repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()));

  // step 2 — details form
  if (selected) {
    return (
      <Modal title="New project" onClose={onClose}>
        <div className="field">
          <label>Project name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Repository</label>
          <div className="row between card" style={{ margin: 0, padding: '10px 12px' }}>
            <span>{selected.fullName}</span>
            {selected.private && <span className="tag">private</span>}
          </div>
        </div>
        <div className="field">
          <label>Default branch (agents branch from here)</label>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} />
        </div>
        <div className="field">
          <label>Description / goal (optional)</label>
          <textarea
            rows={3}
            placeholder="What is this project about? What should the crew focus on?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {err && <div className="banner err">{err}</div>}
        <div className="row between">
          <button className="btn sm" onClick={() => setSelected(undefined)}>
            ‹ back
          </button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? 'creating…' : 'Create project'}
          </button>
        </div>
      </Modal>
    );
  }

  // step 1 — pick repo
  return (
    <Modal title="Pick a repository" onClose={onClose}>
      <div className="field">
        <input placeholder="filter repos…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
      </div>
      {err && <div className="banner err">{err}</div>}
      {loading ? (
        <div className="spinner">loading repos…</div>
      ) : (
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {shown.map((r) => (
            <div className="card click row between" key={r.fullName} style={{ marginBottom: 8 }} onClick={() => pick(r)}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.fullName}</span>
                  {r.private && <span className="tag">private</span>}
                </div>
                {r.description && <div className="muted small">{r.description}</div>}
              </div>
              <span className="muted">›</span>
            </div>
          ))}
          {shown.length === 0 && <div className="empty">no matching repos.</div>}
        </div>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------------------
// Projects page
// --------------------------------------------------------------------------

export function Projects() {
  const navigate = useNavigate();
  const [conn, setConn] = useState<GitHubConnection>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.connection().then(setConn).catch(() => setConn({ connected: false }));
    api.projects().then((r) => setProjects(r.projects)).catch(() => undefined);
  }, []);

  const disconnect = async () => {
    await api.disconnect();
    setConn({ connected: false });
  };

  const remove = async (id: string) => {
    await api.deleteProject(id);
    setProjects((p) => p.filter((x) => x.id !== id));
  };

  // Connect is never in the app-bar; the only connect entry point lives in the
  // empty state below. When connected, the app-bar offers "+ Add".
  const headerAction = conn?.connected ? (
    <button className="btn sm primary" onClick={() => setAdding(true)}>
      + Add
    </button>
  ) : undefined;

  return (
    <Screen title="Projects" back actions={headerAction}>
      {/* not connected */}
      {conn && !conn.connected && (
        <div className="empty">
          <div style={{ fontSize: 40, color: 'var(--accent)', marginBottom: 12 }}>▤</div>
          Connect your GitHub account to start
          <br />
          managing projects and their backlogs.
          <div style={{ marginTop: 22 }}>
            <button className="btn primary" onClick={() => setConnecting(true)}>
              Connect
            </button>
          </div>
        </div>
      )}

      {/* connected */}
      {conn?.connected && (
        <>
          <div className="card row between">
            <div className="row" style={{ gap: 8 }}>
              <span className="tag state">GitHub</span>
              <span className="muted small">@{conn.login}</span>
            </div>
            <button className="btn sm" onClick={disconnect}>
              disconnect
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="empty">
              <div style={{ fontSize: 40, color: 'var(--accent)', marginBottom: 12 }}>＋</div>
              You don't have any projects yet.
              <br />
              Add a repository to start working on it.
              <div style={{ marginTop: 22 }}>
                <button className="btn primary" onClick={() => setAdding(true)}>
                  + Add your first project
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="section-title">Your projects</div>
              {projects.map((p) => (
                <div className="card click row between" key={p.id}>
                  <div className="grow" onClick={() => navigate(`/projects/${p.id}`)} role="button">
                    <div style={{ fontWeight: 700 }}>{p.name}</div>
                    <div className="muted small">{p.repo}</div>
                    {p.description && (
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {p.description}
                      </div>
                    )}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="tag">{p.agentCount ?? 0} agents</span>
                    <button className="btn sm danger" onClick={() => remove(p.id)}>
                      remove
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {connecting && (
        <ConnectModal
          onClose={() => setConnecting(false)}
          onConnected={(c) => {
            setConn(c);
            setConnecting(false);
          }}
        />
      )}
      {adding && (
        <AddProjectModal
          onClose={() => setAdding(false)}
          onAdded={(p) => {
            setProjects((prev) => [p, ...prev]);
            setAdding(false);
          }}
        />
      )}
    </Screen>
  );
}
