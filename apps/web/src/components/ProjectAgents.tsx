import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  providerInfo,
  type AgentSnapshot,
  type AgentTemplate,
  type DeployedAgent,
} from '@tractus/shared';
import { Modal } from './Modal.js';
import { AgentForm, type AgentDraft } from './AgentForm.js';
import { api } from '../api.js';

/** Human label for a provider+model id, e.g. "Claude Code · Sonnet 4.6". */
function providerModelLabel(provider: string, model: string): string {
  const info = providerInfo(provider as Parameters<typeof providerInfo>[0]);
  const m = info.models.find((x) => x.id === model);
  const short = m ? m.label.split('—')[0].trim() : model;
  return `${info.name} · ${short}`;
}

function DeployModal({
  projectId,
  onClose,
  onDeployed,
}: {
  projectId: string;
  onClose: () => void;
  onDeployed: (a: DeployedAgent) => void;
}) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [snapshots, setSnapshots] = useState<AgentSnapshot[]>([]);
  const [selected, setSelected] = useState<AgentTemplate>();
  const [draft, setDraft] = useState<AgentDraft>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    api.templates().then((r) => setTemplates(r.templates)).catch(() => undefined);
    api.snapshots().then((r) => setSnapshots(r.snapshots)).catch(() => undefined);
  }, []);

  const pick = (t: AgentTemplate) => {
    setSelected(t);
    setDraft({
      name: t.name,
      provider: t.provider,
      model: t.model,
      dailyBudgetUsd: t.defaultDailyBudgetUsd,
      instructions: t.instructions,
      skills: t.skills,
    });
  };

  const deploy = async () => {
    if (!selected || !draft) return;
    setBusy(true);
    setErr(undefined);
    try {
      const { agent } = await api.deployAgent(projectId, { templateId: selected.id, ...draft });
      onDeployed(agent);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  // Add an already-trained agent: spawn one copy from its snapshot image.
  const addTrained = async (snap: AgentSnapshot) => {
    setBusy(true);
    setErr(undefined);
    try {
      const { agents } = await api.spawnFromSnapshot(snap.id, projectId, 1);
      if (agents[0]) onDeployed(agents[0]);
      else throw new Error('spawn returned no agent');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  // step 2 — customize (templates only)
  if (selected && draft) {
    return (
      <Modal title={`Add ${selected.name}`} onClose={onClose} size="large">
        <AgentForm value={draft} onChange={setDraft} />
        {err && <div className="banner err">{err}</div>}
        <div className="row between">
          <button className="btn sm" onClick={() => setSelected(undefined)}>
            ‹ back
          </button>
          <button className="btn primary" disabled={!draft.name.trim() || busy} onClick={deploy}>
            {busy ? 'adding…' : 'Add agent'}
          </button>
        </div>
      </Modal>
    );
  }

  // step 1 — pick a template or a trained agent
  return (
    <Modal title="Add an agent" onClose={onClose} size="large">
      {err && <div className="banner err">{err}</div>}

      <div className="section-title">Templates</div>
      <div className="picker-grid">
        {templates.map((t) => (
          <div className="card click" key={t.id} onClick={() => !busy && pick(t)}>
            <div className="row between">
              <span style={{ fontWeight: 700 }}>{t.name}</span>
              <span className="tag violet">{providerModelLabel(t.provider, t.model)}</span>
            </div>
            <div className="muted small" style={{ margin: '8px 0', lineHeight: 1.5 }}>
              {t.blurb}
            </div>
            <div className="row between">
              <span className="muted small">default ${t.defaultDailyBudgetUsd}/day</span>
              <span className="muted">›</span>
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">Trained agents</div>
      {snapshots.length === 0 ? (
        <div className="muted small" style={{ lineHeight: 1.6 }}>
          No trained agents yet. Snapshot a deployed agent to capture its trained
          image, then add copies here.
        </div>
      ) : (
        <div className="picker-grid">
          {snapshots.map((s) => (
            <div className="card click" key={s.id} onClick={() => !busy && addTrained(s)}>
              <div className="row between">
                <div className="row" style={{ gap: 10 }}>
                  <span className="tag state">{s.role}</span>
                  <span style={{ fontWeight: 700 }}>{s.name}</span>
                </div>
                <span className="tag violet">trained</span>
              </div>
              <div className="muted small" style={{ margin: '8px 0', lineHeight: 1.5 }}>
                {s.notes || s.imageTag}
              </div>
              <div className="row between">
                <span className="muted small">{s.skills.length} skills</span>
                <span className="muted">{busy ? 'adding…' : '+ add copy'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function ProjectAgents({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<DeployedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    api
      .agents(projectId)
      .then((r) => setAgents(r.agents))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <div className="spinner">loading agents…</div>;

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="muted small">{agents.length} deployed</span>
        <button className="btn sm primary" onClick={() => setDeploying(true)}>
          + Add agent
        </button>
      </div>

      {agents.length === 0 ? (
        <div className="empty">No agents deployed. Add one to staff this project.</div>
      ) : (
        agents.map((a) => (
          <div
            className="card click"
            key={a.id}
            onClick={() => navigate(`/projects/${projectId}/agents/${a.id}`)}
          >
            <div className="row between">
              <div className="row" style={{ gap: 10 }}>
                <span className="tag state">{a.role}</span>
                <span style={{ fontWeight: 700 }}>{a.name}</span>
              </div>
              <span className="tag violet">{providerModelLabel(a.provider, a.model)}</span>
            </div>
            <div className="row between" style={{ marginTop: 10 }}>
              <span className="muted small">
                budget ${a.dailyBudgetUsd.toFixed(2)}/day · {a.skills.length} skills
              </span>
              <span
                className="small"
                style={{ color: a.status === 'running' ? 'var(--signal)' : 'var(--text-dim)' }}
              >
                {a.status}
              </span>
            </div>
          </div>
        ))
      )}

      {deploying && (
        <DeployModal
          projectId={projectId}
          onClose={() => setDeploying(false)}
          onDeployed={(a) => {
            setAgents((prev) => [...prev, a]);
            setDeploying(false);
          }}
        />
      )}
    </>
  );
}
