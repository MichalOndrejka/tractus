import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { connectWs } from '../api.js';

function useLive(): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => connectWs(() => {}, setLive), []);
  return live;
}

export function Screen({
  title,
  accent,
  back,
  actions,
  fill,
  children,
}: {
  title: string;
  accent?: string;
  back?: boolean;
  actions?: ReactNode;
  /** Full-bleed body: no centered max-width / padding; children manage layout. */
  fill?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const live = useLive();
  return (
    <div className="app">
      <header className="appbar">
        {back && (
          <button className="back" onClick={() => navigate(-1)} aria-label="Back">
            ‹
          </button>
        )}
        <span className="title">
          {title}
          {accent && <span className="accent"> {accent}</span>}
        </span>
        <span className="spacer" />
        {actions}
        <span className={`dot ${live ? 'live' : ''}`} title={live ? 'live' : 'offline'} />
      </header>
      <main className={fill ? 'page-fill' : 'page'}>{children}</main>
    </div>
  );
}
