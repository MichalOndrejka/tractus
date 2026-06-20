import { useEffect, useState } from 'react';
import type {
  AgentContainerStatus,
  AgentLearning,
  AgentSnapshot,
  DeployedAgent,
} from '@tractus/shared';
import { AgentForm, type AgentDraft } from './AgentForm.js';
import { api } from '../api.js';

// --------------------------------------------------------------------------
// Everything that configures an agent: its persona/skills/model/budget, its
// persistent environment, snapshot-and-multiply, the self-improvement history,
// and removal. Owns its own form draft; bubbles agent updates up so the other
// tabs (stats, header) stay in sync.
// --------------------------------------------------------------------------

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

export function AgentCustomization({
  agent,
  projectId,
  onAgentChange,
  onRemoved,
}: {
  agent: DeployedAgent;
  projectId: string;
  onAgentChange: (a: DeployedAgent) => void;
  onRemoved: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(draftFromAgent(agent));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [container, setContainer] = useState<AgentContainerStatus>();
  const [envBusy, setEnvBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [snapshot, setSnapshot] = useState<AgentSnapshot>();
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapErr, setSnapErr] = useState<string>();
  const [copies, setCopies] = useState(2);
  const [spawnMsg, setSpawnMsg] = useState<string>();
  const [learning, setLearning] = useState<AgentLearning[]>([]);

  useEffect(() => {
    api.container(agent.id).then((r) => setContainer(r.container)).catch(() => undefined);
    api.learning(agent.id).then((r) => setLearning(r.learning)).catch(() => undefined);
  }, [agent.id]);

  // Keep the form in sync when the agent changes outside this tab (e.g. a
  // self-improvement rewrote its instructions while running).
  useEffect(() => {
    setDraft(draftFromAgent(agent));
  }, [agent]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const { agent: updated } = await api.updateAgent(agent.id, {
        name: draft.name,
        provider: draft.provider,
        model: draft.model,
        dailyBudgetUsd: draft.dailyBudgetUsd,
        instructions: draft.instructions,
        skills: draft.skills,
      });
      onAgentChange(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await api.deleteAgent(agent.id);
    onRemoved();
  };

  const toggleContainer = async (start: boolean) => {
    setEnvBusy(true);
    setErr(undefined);
    try {
      const { container: c } = start
        ? await api.startContainer(agent.id)
        : await api.stopContainer(agent.id);
      setContainer(c);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setEnvBusy(false);
    }
  };

  const takeSnapshot = async () => {
    setSnapBusy(true);
    setSnapErr(undefined);
    setSpawnMsg(undefined);
    try {
      const { snapshot: s } = await api.snapshotAgent(agent.id);
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
    const { agent: updated } = await api.updateAgent(agent.id, { learningEnabled: enabled });
    onAgentChange(updated);
  };

  const rollback = async (entryId: string) => {
    const { agent: updated } = await api.rollbackLearning(agent.id, entryId);
    onAgentChange(updated);
    api.learning(agent.id).then((r) => setLearning(r.learning)).catch(() => undefined);
  };

  return (
    <div>
      <div className="section-title">Configuration</div>
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

      <div className="section-title">Environment</div>
      <div className="card">
        <div className="row between">
          <span className="muted">Container</span>
          <span style={{ color: container?.state === 'running' ? 'var(--signal)' : 'var(--text-dim)' }}>
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
        {err && <div className="banner err" style={{ marginBottom: 10 }}>{err}</div>}
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
    </div>
  );
}
