import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BacklogItem, DeployedAgent, LogLine, Run } from '@tractus/shared';
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

  const spentPct = Math.min(100, (agent.spentTodayUsd / Math.max(agent.dailyBudgetUsd, 0.01)) * 100);

  return (
    <Screen title={agent.name} accent={`· ${agent.role}`} back>
      <div className="card">
        <div className="row between">
          <span className="muted">Status</span>
          <span style={{ color: agent.status === 'running' ? 'var(--accent)' : 'var(--text-dim)' }}>
            {agent.status}
          </span>
        </div>
        <div className="row between" style={{ marginTop: 10 }}>
          <span className="muted">Spent today</span>
          <span style={{ color: spentPct > 80 ? 'var(--danger)' : 'var(--accent)' }}>
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
              ? 'var(--accent)'
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
