import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { BacklogItem, ChatUsage, DeployedAgent, LogLine, Run } from '@tractus/shared';
import { Screen } from '../components/Screen.js';
import { Modal } from '../components/Modal.js';
import { AgentChat } from '../components/AgentChat.js';
import { AgentStats } from '../components/AgentStats.js';
import { AgentCustomization } from '../components/AgentCustomization.js';
import { mergeLogLines } from '../components/LogFeed.js';
import { api, connectWs } from '../api.js';

type Tab = 'chat' | 'stats' | 'config';

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
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'chat';
  const [agent, setAgent] = useState<DeployedAgent>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [chatUsage, setChatUsage] = useState<ChatUsage>();
  const [picking, setPicking] = useState(false);
  const [runErr, setRunErr] = useState<string>();

  useEffect(() => {
    if (!agentId) return;
    api.agent(agentId).then((r) => setAgent(r.agent)).catch(() => undefined);
    api.agentRuns(agentId).then((r) => setRuns(r.runs)).catch(() => undefined);
    api.agentLogs(agentId).then((r) => setLogs(r.logs)).catch(() => undefined);
    api.agentChatUsage(agentId).then((r) => setChatUsage(r.usage)).catch(() => undefined);
  }, [agentId]);

  // After a chat turn, refresh the agent (spend-today) and the chat usage totals
  // so the Stats tab reflects what the conversation cost.
  const onChatSent = () => {
    if (!agentId) return;
    api.agent(agentId).then((r) => setAgent(r.agent)).catch(() => undefined);
    api.agentChatUsage(agentId).then((r) => setChatUsage(r.usage)).catch(() => undefined);
  };

  // live stream: append logs + run status for this agent's runs
  useEffect(() => {
    if (!agentId) return;
    const prefix = `${agentId}:`;
    return connectWs(
      (e) => {
        if (e.type === 'log' && e.line.runId.startsWith(prefix)) {
          setLogs((prev) => mergeLogLines(prev, [e.line]));
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

  if (!agent || !agentId || !projectId) return null;

  const triggerRun = async (workItemNumber: number) => {
    setPicking(false);
    setRunErr(undefined);
    try {
      const { run } = await api.runAgent(agentId, workItemNumber);
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      setAgent((a) => (a ? { ...a, status: 'running' } : a));
      setParams({ tab: 'stats' });
    } catch (e) {
      setRunErr(String(e instanceof Error ? e.message : e));
    }
  };

  const runAction = (
    <button
      className="btn primary sm"
      disabled={agent.status === 'running'}
      onClick={() => setPicking(true)}
    >
      {agent.status === 'running' ? 'running…' : '▶ Run'}
    </button>
  );

  return (
    <Screen
      title={agent.name}
      accent={`· ${agent.role} · ${agent.status}`}
      back
      actions={runAction}
    >
      <nav className="tabs">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setParams({ tab: 'chat' })}>
          ❯ Chat
        </button>
        <button className={tab === 'stats' ? 'active' : ''} onClick={() => setParams({ tab: 'stats' })}>
          ▲ Stats
        </button>
        <button className={tab === 'config' ? 'active' : ''} onClick={() => setParams({ tab: 'config' })}>
          ⚙ Customization
        </button>
      </nav>

      {runErr && <div className="banner err">{runErr}</div>}

      {tab === 'chat' ? (
        <AgentChat agent={agent} onSent={onChatSent} />
      ) : tab === 'stats' ? (
        <AgentStats agent={agent} runs={runs} logs={logs} chat={chatUsage} />
      ) : (
        <AgentCustomization
          agent={agent}
          projectId={projectId}
          onAgentChange={setAgent}
          onRemoved={() => navigate(`/projects/${projectId}?tab=agents`)}
        />
      )}

      {picking && (
        <RunPicker projectId={projectId} onClose={() => setPicking(false)} onPick={triggerRun} />
      )}
    </Screen>
  );
}
