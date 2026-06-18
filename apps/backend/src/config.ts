import 'dotenv/config';
import { resolve } from 'node:path';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num(process.env.PORT, 8787),
  databasePath: resolve(process.env.DATABASE_PATH ?? './data/tractus.sqlite'),
  github: {
    token: process.env.GITHUB_TOKEN ?? '',
    repos: (process.env.GITHUB_REPOS ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    botLabel: process.env.BOT_LABEL ?? 'tractus',
  },
  budget: {
    dailyLimitUsd: num(process.env.DAILY_BUDGET_USD, 10),
    concurrencyLimit: num(process.env.CONCURRENCY_LIMIT, 2),
    perTaskTokenCap: num(process.env.PER_TASK_TOKEN_CAP, 200_000),
  },
  // Consecutive failed runs on one work item before it stops auto-retrying and
  // is parked in BLOCKED (prevents an infinite retry/spend loop under dispatch).
  maxRetries: num(process.env.MAX_RETRIES, 2),
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  // Base image new agents are created from until they have a trained snapshot.
  agentImage: process.env.AGENT_IMAGE ?? 'tractus/agent:latest',
  // Prefix for per-type golden images produced by snapshotting (`<prefix><role>:<tag>`).
  agentImagePrefix: process.env.AGENT_IMAGE_PREFIX ?? 'tractus/agent-',
  // How long a persistent agent container may sit idle (no running run) before the
  // reaper stops it to free resources. It is started again on the next dispatch.
  agentIdleStopMs: num(process.env.AGENT_IDLE_STOP_MS, 10 * 60 * 1000),
  // Auto-persist an agent's container to its own image whenever its environment
  // changes (tooling installed, self-update) so the state is durable and inherited
  // by spawned copies — no manual snapshot needed. Set '0' to disable.
  autoSnapshot: process.env.AGENT_AUTO_SNAPSHOT !== '0',
  // Shared secret that lets an external trigger (n8n) call POST /api/dispatch/tick
  // without a browser session. Empty = the tick endpoint requires a logged-in session.
  dispatchToken: process.env.DISPATCH_TOKEN ?? '',
  // How often the backend runs its own dispatch pass (auto-pickup of Ready items)
  // so it works out of the box without an external trigger. An n8n timer can still
  // POST /api/dispatch/tick on top of this; both are idempotent. 0 disables the timer.
  dispatchIntervalMs: num(process.env.DISPATCH_INTERVAL_MS, 15_000),
  // When '1', containers simulate the work (no clone/push/PR, no LLM, no cost).
  dryRun: process.env.AGENT_DRY_RUN === '1',
  runTimeoutMs: num(process.env.RUN_TIMEOUT_MS, 20 * 60 * 1000),
};

export const githubConfigured = Boolean(config.github.token && config.github.repos.length);
