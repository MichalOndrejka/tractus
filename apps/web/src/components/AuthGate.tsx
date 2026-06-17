import { useEffect, useState, type ReactNode } from 'react';
import { api, type AuthStatus } from '../api.js';

function AuthForm({
  setupRequired,
  onAuthed,
}: {
  setupRequired: boolean;
  onAuthed: (s: AuthStatus) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const result = setupRequired
        ? await api.signup(email.trim(), password)
        : await api.login(email.trim(), password);
      onAuthed(result);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <div className="authwrap">
      <div className="authcard">
        <div className="brand">TRACTUS</div>
        <div className="sub">
          {setupRequired
            ? 'Create the owner account. This is the only account — sign-up locks afterwards, so only you can get in.'
            : 'Sign in to your workspace.'}
        </div>
        <div className="field">
          <label>Email</label>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <label>Password{setupRequired ? ' (min 8 characters)' : ''}</label>
          <input
            type="password"
            autoComplete={setupRequired ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && email && password && submit()}
          />
        </div>
        {err && <div className="banner err">{err}</div>}
        <button className="btn primary" disabled={!email || !password || busy} onClick={submit}>
          {busy ? '…' : setupRequired ? 'Create account' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | 'loading'>('loading');

  useEffect(() => {
    api
      .authStatus()
      .then(setStatus)
      .catch(() => setStatus({ setupRequired: false, authenticated: false }));
  }, []);

  if (status === 'loading') {
    return (
      <div className="authwrap">
        <div className="spinner">booting…</div>
      </div>
    );
  }

  if (!status.authenticated) {
    return <AuthForm setupRequired={status.setupRequired} onAuthed={setStatus} />;
  }

  return <>{children}</>;
}
