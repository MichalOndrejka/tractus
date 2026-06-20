import { useEffect, useRef, useState } from 'react';
import { providerInfo, type ChatMessage, type DeployedAgent } from '@tractus/shared';
import { api } from '../api.js';

/** Friendly, short model name for an agent (e.g. "Opus 4.8"), falling back to its id. */
function modelLabel(agent: DeployedAgent): string {
  const label = providerInfo(agent.provider).models.find((m) => m.id === agent.model)?.label;
  return (label ?? agent.model).split('—')[0].trim();
}

// --------------------------------------------------------------------------
// Direct chat with a deployed agent. The thread is persisted server-side; each
// send replays the history through the agent's own container so it answers with
// its current instructions, skills and trained environment.
// --------------------------------------------------------------------------

function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
}

export function AgentChat({
  agent,
  onSent,
}: {
  agent: DeployedAgent;
  /** Fired after a turn completes so the parent can refresh spend/usage. */
  onSent?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    api
      .agentChat(agent.id)
      .then((r) => setMessages(r.messages))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)))
      .finally(() => setLoading(false));
  }, [agent.id]);

  // Stick to the bottom as messages arrive.
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setErr(undefined);
    setDraft('');
    setSending(true);
    // Optimistically show the operator's line immediately.
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      agentId: agent.id,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const { messages: appended, change } = await api.sendAgentChat(agent.id, text);
      // Replace the optimistic line with the canonical user+agent pair.
      setMessages((prev) => [...prev.filter((m) => m.id !== optimistic.id), ...appended]);
      // Tag the agent reply with any self-config it just applied.
      const agentReply = appended.find((m) => m.role === 'agent');
      if (change && agentReply) {
        setChanges((prev) => ({ ...prev, [agentReply.id]: change }));
      }
      onSent?.();
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(text);
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSending(false);
    }
  };

  const clear = async () => {
    await api.clearAgentChat(agent.id).catch(() => undefined);
    setMessages([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat">
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          <span className="muted small" style={{ minWidth: 0 }}>
            Talk to {agent.name} directly. Ask it to change how it works — adjust instructions, add a
            skill, switch model or budget — and it reconfigures itself.
          </span>
        </span>
        <span className="row" style={{ gap: 8, flex: '0 0 auto' }}>
          <span className="tag violet" title={agent.model}>
            ⌬ {modelLabel(agent)}
          </span>
          {messages.length > 0 && (
            <button className="btn sm" onClick={clear}>
              clear
            </button>
          )}
        </span>
      </div>

      <div className="chat-thread" ref={boxRef}>
        {loading ? (
          <div className="spinner">loading conversation…</div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">
            No messages yet. Say hello, ask how it would approach a work item, or probe its
            understanding of the project.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-bubble">{m.content}</div>
              {changes[m.id] && <div className="chat-change">⚙ {changes[m.id]}</div>}
              <div className="chat-meta">
                {m.role === 'user' ? 'you' : agent.name} · {clock(m.createdAt)}
              </div>
            </div>
          ))
        )}
        {sending && (
          <div className="chat-msg agent">
            <div className="chat-bubble thinking">
              <span className="pulse" /> {agent.name} is thinking…
            </div>
          </div>
        )}
      </div>

      {err && <div className="banner err" style={{ marginTop: 10 }}>{err}</div>}

      <div className="chat-input">
        <textarea
          rows={2}
          placeholder={`Message ${agent.name}…  (Enter to send, Shift+Enter for newline)`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
        />
        <button className="btn primary" disabled={sending || !draft.trim()} onClick={send}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
