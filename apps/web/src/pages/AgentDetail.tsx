import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  AgentContainerStatus,
  AgentLearning,
  AgentSnapshot,
  BacklogItem,
  DeployedAgent,
  LogLine,
  Run,
} from '@tractus/shared';
import { Screen } from '../components/Screen.js';
import { Modal } from '../components/Modal.js';
import { AgentForm, type AgentDraft } from '../components/AgentForm.js';
import { api, connectWs } from '../api.js';

function draftFromAgent(a: DeployedAgent): AgentDraft {
  return {
    name: a.name,
    provider: a.provider,
    model: a.model,
    dailyBudgetUsd: a.dailyBudgetUsd,
    instructions: a.instructions,
    skills: a.skills,
  };
}

function RunPicker({
  projectId,
  onClose,
  onPick,
}: {
  projectId: string;
  onClose: () => void;
  onPick: (n: number) => void;
}) {
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api
      .backlog(projectId)
      .then((r) => setItems(r.items))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  return (
    <Modal title="Run on a work item" onClose={onClose}>
      {err && <div className="banner err">{err}</div>}
      {loading ? (
        <div className="spinner">loading work items…</div>
      ) : items.length === 0 ? (
        <div className="empty">No work items in this project yet.</div>
      ) : (
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {items.map((it) => (
            <div className="card click row between" key={it.number} onClick={() => onPick(it.number)}>
              <div className="grow" style={{ minWidth: 0 }}>
                <span className="muted small">#{it.number}</span>
                <div style={{ fontSize: 13 }}>{it.title}</div>
              </div>
              <span className="muted">›</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function AgentDetail() {
  const { id: projectId, agentId } = useParams<{ id: string; agentId: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<DeployedAgent>();
  const [draft, setDraft] = useState<AgentDraft>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [logsByRun, setLogsByRun] = useState<Record<string, LogLine[]>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [picking, setPicking] = useState(false);
  const [runErr, setRunErr] = useState<string>();
  const [container, setContainer] = useState<AgentContainerStatus>();
  const [envBusy, setEnvBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<AgentSnapshot>();
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapErr, setSnapErr] = useState<string>();
  const [copies, setCopies] = useState(2);
  const [spawnMsg, setSpawnMsg] = useState<string>();
  const [learning, setLearning] = useState<AgentLearning[]>([]);
  const agentRef = useRef(agentId);
  agentRef.current = agentId;

  useEffect(() => {
    if (!agentId) return;
    api.agent(agentId).then((r) => {
      setAgent(r.agent);
      setDraft(draftFromAgent(r.agent));
    });
    api.agentRuns(agentId).then(async (r) => {
      setRuns(r.runs);
      const seed: Record<string, LogLine[]> = {};
      await Promise.all(
        r.runs.map((run) => api.logs(run.id).then((l) => (seed[run.id] = l.logs)).catch(() => undefined)),
      );
      setLogsByRun(seed);
    });
    api.container(agentId).then((r) => setContainer(r.container)).catch(() => undefined);
    api.learning(agentId).then((r) => setLearning(r.learning)).catch(() => undefined);
  }, [agentId]);

  // live stream: append logs + run status for this agent's runs
  useEffect(() => {
    if (!agentId) return;
    const prefix = `${agentId}:`;
    return connectWs(
      (e) => {
        if (e.type === 'log' && e.line.runId.startsWith(prefix)) {
          setLogsByRun((prev) => ({
            ...prev,
            [e.line.runId]: [...(prev[e.line.runId] ?? []), e.line],
          }));
        } else if (e.type === 'run.updated' && e.run.id.startsWith(prefix)) {
          setRuns((prev) => {
            const i = prev.findIndex((r) => r.id === e.run.id);
            if (i === -1) return [e.run, ...prev];
            const next = [...prev];
            next[i] = e.run;
            return next;
          });
          if (e.run.status !== 'running') {
            api.agent(agentId).then((r) => setAgent(r.agent)).catch(() => undefined);
          }
        }
      },
      () => {},
    );
  }, [agentId]);

  if (!agent || !draft || !agentId || !projectId) return null;

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const { agent: updated } = await api.updateAgent(agentId, {
        name: draft.name,
        provider: draft.provider,
        model: draft.model,
        dailyBudgetUsd: draft.dailyBudgetUsd,
        instructions: draft.instructions,
        skills: draft.skills,
      });
      setAgent(updated);
      setDraft(draftFromAgent(updated));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const triggerRun = async (workItemNumber: number) => {
    setPicking(false);
    setRunErr(undefined);
    try {
      const { run } = await api.runAgent(agentId, workItemNumber);
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      setLogsByRun((prev) => ({ ...prev, [run.id]: prev[run.id] ?? [] }));
      setAgent((a) => (a ? { ...a, status: 'running' } : a));
    } catch (e) {
      setRunErr(String(e instanceof Error ? e.message : e));
    }
  };

  const remove = async () => {
    await api.deleteAgent(agentId);
    navigate(`/projects/${projectId}?tab=agents`);
  };

  const toggleContainer = async (start: boolean) => {
    setEnvBusy(true);
    try {
      const { container: c } = start
        ? await api.startContainer(agentId)
        : await api.stopContainer(agentId);
      setContainer(c);
    } catch (e) {
      setRunErr(String(e instanceof Error ? e.message : e));
    } finally {
      setEnvBusy(false);
    }
  };

  const takeSnapshot = async () => {
    setSnapBusy(true);
    setSnapErr(undefined);
    setSpawnMsg(undefined);
    try {
      const { snapshot: s } = await api.snapshotAgent(agentId);
      setSnapshot(s);
    } catch (e) {
      setSnapErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSnapBusy(false);
    }
  };

  const spawnCopies = async () => {
    if (!snapshot) return;
    setSnapBusy(true);
    setSnapErr(undefined);
    try {
      const { agents } = await api.spawnFromSnapshot(snapshot.id, projectId, copies);
      setSpawnMsg(`Spawned ${agents.length} cop${agents.length === 1 ? 'y' : 'ies'} into this project.`);
    } catch (e) {
      setSnapErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSnapBusy(false);
    }
  };

  const toggleLearning = async (enabled: boolean) => {
    const { agent: updated } = await api.updateAgent(agentId, { learningEnabled: enabled });
    setAgent(updated);
  };

  const rollback = async (entryId: string) => {
    const { agent: updated } = await api.rollbackLearning(agentId, entryId);
    setAgent(updated);
    setDraft(draftFromAgent(updated));
    api.learning(agentId).then((r) => setLearning(r.learning)).catch(() => undefined);
  };

  const spentPct = Math.min(100, (agent.spentTodayUsd / Math.max(agent.dailyBudgetUsd, 0.01)) * 100);

  return (
    <Screen title={agent.name} accent={`· ${agent.role}`} back>
      <div className="card">
        <div className="row between">
          <span className="muted">Status</span>
          <span style={{ color: agent.status === 'running' ? 'var(--signal)' : 'var(--text-dim)' }}>
            {agent.status}
          </span>
        </div>
        <div className="row between" style={{ marginTop: 10 }}>
          <span className="muted">Spent today</span>
          <span style={{ color: spentPct > 80 ? 'var(--danger)' : 'var(--signal)' }}>
            ${agent.spentTodayUsd.toFixed(2)} / ${agent.dailyBudgetUsd.toFixed(2)}
          </span>
        </div>
        <div className="meter" style={{ margin: '8px 0 12px' }}>
          <span className={spentPct > 80 ? 'hot' : ''} style={{ width: `${spentPct}%` }} />
        </div>
        <button
          className="btn primary"
          disabled={agent.status === 'running'}
          onClick={() => setPicking(true)}
        >
          {agent.status === 'running' ? 'running…' : '▶ Run on a work item'}
        </button>
        {runErr && <div className="banner err" style={{ marginTop: 10 }}>{runErr}</div>}
      </div>

      <div className="section-title">Environment</div>
      <div className="card">
        <div className="row between">
          <span className="muted">Container</span>
          <span
            style={{
              color: container?.state === 'running' ? 'var(--signal)' : 'var(--text-dim)',
            }}
          >
            {container?.state ?? '…'}
          </span>
        </div>
        {container?.image && (
          <div className="row between" style={{ marginTop: 8 }}>
            <span className="muted">Image</span>
            <code className="small">{container.image}</code>
          </div>
        )}
        <p className="muted small" style={{ margin: '8px 0 12px' }}>
          A long-lived container per agent. Tooling and the repo clone persist across runs;
          it’s stopped when idle to save resources and started again on dispatch. Environment
          changes (installed tooling, self-updates) are saved automatically to the agent’s own
          image, so spawned copies inherit them — no manual snapshot needed.
        </p>
        <div className="row between">
          <button
            className="btn sm"
            disabled={envBusy || container?.state === 'stopped' || container?.state === 'absent'}
            onClick={() => toggleContainer(false)}
          >
            stop
          </button>
          <button
            className="btn sm"
            disabled={envBusy || container?.state === 'running'}
            onClick={() => toggleContainer(true)}
          >
            {container?.state === 'absent' ? 'create & start' : 'start'}
          </button>
        </div>
      </div>

      <div className="section-title">Snapshot &amp; multiply</div>
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>
          Fork this trained agent into identical copies. Its environment is already saved
          automatically; this captures the current image + instructions/skills as a named
          snapshot you can multiply into a project.
        </p>
        {snapErr && <div className="banner err" style={{ marginBottom: 10 }}>{snapErr}</div>}
        {!snapshot ? (
          <button className="btn" disabled={snapBusy} onClick={takeSnapshot}>
            {snapBusy ? 'snapshotting…' : '📸 Snapshot this agent'}
          </button>
        ) : (
          <>
            <div className="row between" style={{ marginBottom: 10 }}>
              <span className="muted small">image</span>
              <code className="small">{snapshot.imageTag}</code>
            </div>
            <div className="row between">
              <label className="muted small">
                copies{' '}
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={copies}
                  onChange={(e) => setCopies(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  style={{ width: 56 }}
                />
              </label>
              <button className="btn primary sm" disabled={snapBusy} onClick={spawnCopies}>
                {snapBusy ? 'spawning…' : 'Spawn copies'}
              </button>
            </div>
          </>
        )}
        {spawnMsg && <div className="banner ok" style={{ marginTop: 10 }}>{spawnMsg}</div>}
      </div>

      <div className="section-title">Learning</div>
      <div className="card">
        <div className="row between">
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={agent.learningEnabled}
              onChange={(e) => toggleLearning(e.target.checked)}
            />
            <span>self-improve after tasks</span>
          </label>
          <span className="muted small">{agent.learningEnabled ? 'on' : 'off (default)'}</span>
        </div>
        <p className="muted small" style={{ margin: '8px 0 0', lineHeight: 1.5 }}>
          When on, the agent reflects after a task — using the transcript and your approval
          feedback — and rewrites its own instructions. Changes apply automatically; every
          version is kept here so you can roll back.
        </p>
        {learning.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {learning.map((l) => (
              <div className="card" key={l.id} style={{ marginBottom: 8 }}>
                <div className="row between">
                  <span className="small">{l.summary}</span>
                  <button className="btn sm" onClick={() => rollback(l.id)}>
                    roll back
                  </button>
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {new Date(l.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section-title">Customization</div>
      <div className="card">
        <AgentForm value={draft} onChange={setDraft} />
        <div className="row between">
          <button className="btn danger sm" onClick={remove}>
            remove agent
          </button>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? 'saving…' : saved ? 'saved ✓' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="section-title">Runs &amp; logs</div>
      {runs.length === 0 ? (
        <div className="empty">No runs yet. Hit “Run on a work item” to launch one.</div>
      ) : (
        runs.map((run) => {
          const lines = logsByRun[run.id] ?? [];
          const color =
            run.status === 'running'
              ? 'var(--signal)'
              : run.status === 'done'
                ? 'var(--text-dim)'
                : 'var(--danger)';
          return (
            <div className="card" key={run.id}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <span className="muted small">
                  #{run.issueNumber} · {run.model}
                </span>
                <span className="small" style={{ color }}>
                  {run.status}
                </span>
              </div>
              <div className="logbox">
                {lines.length === 0
                  ? 'waiting for output…'
                  : lines.map((l) => `[${l.stream}] ${l.content}`).join('\n')}
              </div>
            </div>
          );
        })
      )}

      {picking && (
        <RunPicker projectId={projectId} onClose={() => setPicking(false)} onPick={triggerRun} />
      )}
    </Screen>
  );
}
