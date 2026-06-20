import { useMemo } from 'react';
import type { ChatUsage, DeployedAgent, LogLine, Run } from '@tractus/shared';
import { LogFeed } from './LogFeed.js';
import { UsageChart, type ChartBar } from './UsageChart.js';

const ZERO_CHAT: ChatUsage = { costUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0 };

// --------------------------------------------------------------------------
// Usage & activity for one agent: headline metrics, daily cost/runs charts
// derived from its run history, plus the recent runs and the live log tail.
// --------------------------------------------------------------------------

const DAYS = 14;

/** Local YYYY-MM-DD for an ISO timestamp. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** The last DAYS calendar days as keys, oldest first. */
function recentDays(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="statcard">
      <div className="statval" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="statlabel">{label}</div>
    </div>
  );
}

export function AgentStats({
  agent,
  runs,
  logs,
  chat = ZERO_CHAT,
}: {
  agent: DeployedAgent;
  runs: Run[];
  logs: LogLine[];
  /** Chat thread usage, folded into the spend/token totals alongside runs. */
  chat?: ChatUsage;
}) {
  const stats = useMemo(() => {
    const done = runs.filter((r) => r.status === 'done').length;
    const failed = runs.filter((r) => r.status === 'failed' || r.status === 'killed').length;
    const finished = done + failed;
    const totalCost = runs.reduce((s, r) => s + r.costUsd, 0) + chat.costUsd;
    const tokensIn = runs.reduce((s, r) => s + r.tokensIn, 0) + chat.tokensIn;
    const tokensOut = runs.reduce((s, r) => s + r.tokensOut, 0) + chat.tokensOut;
    const prs = runs.filter((r) => r.prUrl).length;

    const days = recentDays();
    const costByDay = new Map<string, number>();
    const runsByDay = new Map<string, number>();
    for (const r of runs) {
      const k = dayKey(r.startedAt);
      costByDay.set(k, (costByDay.get(k) ?? 0) + r.costUsd);
      runsByDay.set(k, (runsByDay.get(k) ?? 0) + 1);
    }
    const label = (k: string) => k.slice(5); // MM-DD
    const costBars: ChartBar[] = days.map((k) => ({
      label: label(k),
      value: costByDay.get(k) ?? 0,
      title: `${k}: $${(costByDay.get(k) ?? 0).toFixed(2)}`,
    }));
    const runBars: ChartBar[] = days.map((k) => ({
      label: label(k),
      value: runsByDay.get(k) ?? 0,
      title: `${k}: ${runsByDay.get(k) ?? 0} run(s)`,
    }));

    return {
      total: runs.length,
      done,
      failed,
      successPct: finished ? Math.round((done / finished) * 100) : 0,
      totalCost,
      tokensIn,
      tokensOut,
      prs,
      costBars,
      runBars,
    };
  }, [runs, chat]);

  const fmtTokens = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
  const spentPct = Math.min(
    100,
    (agent.spentTodayUsd / Math.max(agent.dailyBudgetUsd, 0.01)) * 100,
  );

  return (
    <div>
      <div className="statgrid">
        <Stat label="Spent today" value={`$${agent.spentTodayUsd.toFixed(2)}`} tone={spentPct > 80 ? 'var(--danger)' : undefined} />
        <Stat label="Total spend" value={`$${stats.totalCost.toFixed(2)}`} />
        <Stat label="Runs" value={String(stats.total)} />
        <Stat label="Success" value={`${stats.successPct}%`} tone="var(--signal)" />
        <Stat label="PRs opened" value={String(stats.prs)} />
        <Stat label="Tokens in / out" value={`${fmtTokens(stats.tokensIn)} / ${fmtTokens(stats.tokensOut)}`} />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span className="muted small">Today’s budget</span>
          <span className="small" style={{ color: spentPct > 80 ? 'var(--danger)' : 'var(--signal)' }}>
            ${agent.spentTodayUsd.toFixed(2)} / ${agent.dailyBudgetUsd.toFixed(2)}
          </span>
        </div>
        <div className="meter">
          <span className={spentPct > 80 ? 'hot' : ''} style={{ width: `${spentPct}%` }} />
        </div>
      </div>

      <div className="section-title">Spend · last {DAYS} days</div>
      <div className="card">
        <UsageChart bars={stats.costBars} format={(v) => `$${v.toFixed(2)}`} />
      </div>

      <div className="section-title">Runs · last {DAYS} days</div>
      <div className="card">
        <UsageChart bars={stats.runBars} accent="var(--violet)" format={(v) => String(Math.round(v))} />
      </div>

      <div className="section-title">Recent runs</div>
      {runs.length === 0 ? (
        <div className="empty">No runs yet.</div>
      ) : (
        runs.slice(0, 20).map((run) => {
          const color =
            run.status === 'running'
              ? 'var(--signal)'
              : run.status === 'done'
                ? 'var(--text-dim)'
                : 'var(--danger)';
          return (
            <div className="card" key={run.id}>
              <div className="row between">
                <span className="muted small">
                  #{run.issueNumber} · {run.role} · {run.model}
                  {run.costUsd > 0 && ` · $${run.costUsd.toFixed(2)}`}
                </span>
                <span className="row" style={{ gap: 10 }}>
                  {run.prUrl && (
                    <a className="small" href={run.prUrl} target="_blank" rel="noreferrer">
                      PR ↗
                    </a>
                  )}
                  <span className="small" style={{ color }}>
                    {run.status}
                  </span>
                </span>
              </div>
            </div>
          );
        })
      )}

      <div className="section-title">Live log</div>
      <LogFeed lines={logs} live={agent.status === 'running'} />
    </div>
  );
}
