/**
 * System log: a single global feed for operational events that aren't tied to a
 * specific agent run — dispatch passes, run/container failures, the budget
 * breaker, startup/reconciliation. It reuses the per-run log pipeline (one row in
 * `log_line` under the reserved `SYSTEM_LOG_RUN_ID`, broadcast as a normal `log`
 * event) so the existing UI log machinery streams it for free.
 */
import { SYSTEM_LOG_RUN_ID, type LogStream } from '@tractus/shared';
import { addLog } from './db.js';
import { broadcast } from './ws.js';

/** Append one line to the system log and stream it to connected dashboards. */
export function slog(stream: LogStream, content: string): void {
  const line = addLog(SYSTEM_LOG_RUN_ID, stream, content);
  broadcast({ type: 'log', line });
}
