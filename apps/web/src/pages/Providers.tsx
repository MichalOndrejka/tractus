import { useEffect, useState } from 'react';
import type {
  ConduitStatus,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderInfo,
} from '@tractus/shared';
import { Screen } from '../components/Screen.js';
import { Modal } from '../components/Modal.js';
import { api } from '../api.js';

const METHOD_LABEL: Record<ProviderAuthMethod, string> = {
  subscription: 'Subscription (OAuth token)',
  'api-key': 'API key (pay-as-you-go)',
};

function ConnectModal({
  provider,
  onClose,
  onConnected,
}: {
  provider: ProviderInfo;
  onClose: () => void;
  onConnected: (c: ProviderConnection) => void;
}) {
  const [method, setMethod] = useState<ProviderAuthMethod>(
    provider.authMethods.includes('subscription') ? 'subscription' : provider.authMethods[0],
  );
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const connect = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      onConnected((await api.connectProvider(provider.id, method, token.trim())).connection);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const isClaude = provider.id === 'claude-code';

  return (
    <Modal title={`Connect ${provider.name}`} onClose={onClose}>
      <div className="field">
        <label>Authentication</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as ProviderAuthMethod)}>
          {provider.authMethods.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </div>

      {isClaude && (
        <p className="muted small" style={{ lineHeight: 1.6, marginTop: 0 }}>
          {method === 'subscription' ? (
            <>
              Use your Claude subscription — no per-token billing. On a machine with Claude Code,
              run <code>claude setup-token</code>, log in, and paste the generated token here.
            </>
          ) : (
            <>
              Pay-as-you-go via the Anthropic API. Paste a key from{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                console.anthropic.com ↗
              </a>
              .
            </>
          )}
        </p>
      )}

      <div className="field">
        <label>Token</label>
        <input
          type="password"
          placeholder={method === 'subscription' ? 'sk-ant-oat… (setup-token output)' : 'sk-ant-…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && token.trim() && connect()}
          autoFocus
        />
      </div>
      {err && <div className="banner err">{err}</div>}
      <button className="btn primary" disabled={!token.trim() || busy} onClick={connect}>
        {busy ? 'saving…' : 'Connect'}
      </button>
    </Modal>
  );
}

function MemoryPanel() {
  const [status, setStatus] = useState<ConduitStatus>();
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [healthy, setHealthy] = useState<boolean>();

  useEffect(() => {
    api
      .conduit()
      .then((s) => {
        setStatus(s);
        setUrl(s.url ?? '');
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const s = await api.saveConduit({
        url: url.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setStatus(s);
      setHealthy(s.healthy);
      setApiKey('');
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const toggleMemory = async (enabled: boolean) => {
    const s = await api.saveConduit({ memoryEnabled: enabled });
    setStatus(s);
  };

  const disconnect = async () => {
    const s = await api.disconnectConduit();
    setStatus(s);
    setUrl('');
    setHealthy(undefined);
  };

  return (
    <div className="card">
      <div className="row between">
        <div className="row" style={{ gap: 10 }}>
          <span style={{ fontWeight: 700 }}>Memory (conduit)</span>
          {status?.connected && <span className="tag state">connected</span>}
          {healthy === true && <span className="tag state">healthy</span>}
          {healthy === false && <span className="tag">unreachable</span>}
        </div>
        {status?.connected && (
          <button className="btn sm" onClick={disconnect}>
            disconnect
          </button>
        )}
      </div>
      <p className="muted small" style={{ margin: '8px 0 12px', lineHeight: 1.5 }}>
        A shared experience store reached over MCP. All agents read and write one pooled memory —
        each run recalls relevant lessons before acting and stores what it learned at the end.
      </p>

      <div className="field">
        <label>Conduit MCP URL</label>
        <input
          placeholder="http://localhost:8000/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="field">
        <label>API key {status?.hasKey && <span className="muted small">(saved — leave blank to keep)</span>}</label>
        <input
          type="password"
          placeholder="conduit bearer key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="row between">
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={status?.memoryEnabled ?? true}
            onChange={(e) => toggleMemory(e.target.checked)}
          />
          <span className="muted small">memory enabled</span>
        </label>
        <button className="btn primary sm" disabled={!url.trim() || busy} onClick={save}>
          {busy ? 'saving…' : status?.connected ? 'Update' : 'Connect'}
        </button>
      </div>
    </div>
  );
}

export function Providers() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [connecting, setConnecting] = useState<ProviderInfo>();
  const [loading, setLoading] = useState(true);

  const load = () =>
    api
      .providers()
      .then((r) => {
        setProviders(r.providers);
        setConnections(r.connections);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const connFor = (id: string) => connections.find((c) => c.id === id);

  const disconnect = async (id: string) => {
    await api.disconnectProvider(id);
    setConnections((prev) => prev.map((c) => (c.id === id ? { id: c.id, connected: false } : c)));
  };

  return (
    <Screen title="Providers" back>
      {loading ? (
        <div className="spinner">loading providers…</div>
      ) : (
        <>
        {providers.map((p) => {
          const conn = connFor(p.id);
          return (
            <div className="card" key={p.id}>
              <div className="row between">
                <div className="row" style={{ gap: 10 }}>
                  <span style={{ fontWeight: 700 }}>{p.name}</span>
                  {!p.available && <span className="tag">coming soon</span>}
                  {conn?.connected && <span className="tag state">connected</span>}
                </div>
                {p.available &&
                  (conn?.connected ? (
                    <button className="btn sm" onClick={() => disconnect(p.id)}>
                      disconnect
                    </button>
                  ) : (
                    <button className="btn sm primary" onClick={() => setConnecting(p)}>
                      Connect
                    </button>
                  ))}
              </div>
              <div className="muted small" style={{ margin: '8px 0 0', lineHeight: 1.5 }}>
                {p.blurb}
              </div>
              {conn?.connected && conn.method && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  via {conn.method === 'subscription' ? 'subscription' : 'API key'}
                </div>
              )}
            </div>
          );
        })}
        <div className="section-title">Memory</div>
        <MemoryPanel />
        </>
      )}

      {connecting && (
        <ConnectModal
          provider={connecting}
          onClose={() => setConnecting(undefined)}
          onConnected={(c) => {
            setConnections((prev) => {
              const others = prev.filter((x) => x.id !== c.id);
              return [...others, c];
            });
            setConnecting(undefined);
          }}
        />
      )}
    </Screen>
  );
}
