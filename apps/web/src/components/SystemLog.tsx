import { useEffect, useState } from 'react';
import { SYSTEM_LOG_RUN_ID, type LogLine } from '@tractus/shared';
import { LogFeed, mergeLogLines } from './LogFeed.js';
import { api, connectWs } from '../api.js';

// --------------------------------------------------------------------------
// Global system log: dispatch passes, run/container failures, and the budget
// breaker. The feed is cross-project (system events aren't project-scoped); it's
// the same wherever it's opened from.
// --------------------------------------------------------------------------

export function SystemLog() {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    api.systemLogs().then((r) => setLogs(r.logs)).catch(() => undefined);
  }, []);

  useEffect(() => {
    return connectWs(
      (e) => {
        if (e.type === 'log' && e.line.runId === SYSTEM_LOG_RUN_ID) {
          setLogs((prev) => mergeLogLines(prev, [e.line]));
        }
      },
      setLive,
    );
  }, []);

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="muted small">
          System events across all projects — dispatch, run failures, the budget breaker.
        </span>
        <span className={`linkstate ${live ? 'live' : ''}`}>
          {live && <span className="pulse" />} {live ? 'live' : 'offline'}
        </span>
      </div>
      <LogFeed lines={logs} live={live} empty="No system events yet." />
    </>
  );
}
