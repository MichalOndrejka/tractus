import { useEffect, useRef } from 'react';
import type { LogLine } from '@tractus/shared';

// --------------------------------------------------------------------------
// Color-coded, auto-scrolling log viewer. Shared by the agent live feed and the
// system log. Sticks to the bottom while you're at the bottom; if you scroll up
// to read scrollback, it stops yanking you down until you return to the bottom.
// --------------------------------------------------------------------------

/** Short HH:MM:SS for a log line's ISO timestamp. */
function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

export function LogFeed({
  lines,
  live,
  empty = 'waiting for output…',
}: {
  lines: LogLine[];
  live?: boolean;
  empty?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true); // are we pinned to the bottom?

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  useEffect(() => {
    const el = boxRef.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="logfeed" ref={boxRef} onScroll={onScroll}>
      {lines.length === 0 ? (
        <div className="logfeed-empty">
          {empty}
          {live && <span className="pulse" style={{ marginLeft: 8 }} />}
        </div>
      ) : (
        lines.map((l) => (
          <div key={l.id} className={`logfeed-line s-${l.stream}`}>
            <span className="logfeed-ts">{clock(l.ts)}</span>
            <span className="logfeed-tag">{l.stream}</span>
            <span className="logfeed-msg">{l.content}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** Append new lines to an existing list, de-duping by id and capping length. */
export function mergeLogLines(prev: LogLine[], incoming: LogLine[], cap = 1000): LogLine[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((l) => l.id));
  const added = incoming.filter((l) => !seen.has(l.id));
  if (added.length === 0) return prev;
  const next = [...prev, ...added];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
