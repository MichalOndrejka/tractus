import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set every env override BEFORE importing config so the non-default side of each
// `?? fallback` / `=== '1'` branch is exercised. The http/db suites run in their
// own processes without these set, covering the default side — together the two
// give config.ts full branch coverage. (node --test runs each file in its own
// process, so these mutations don't leak into the other suites.)
process.env.PORT = '9999';
process.env.DATABASE_PATH = './data/override.sqlite';
process.env.GITHUB_TOKEN = 'ghp_test';
process.env.GITHUB_REPOS = 'owner/a, owner/b ,';
process.env.BOT_LABEL = 'mybot';
process.env.DAILY_BUDGET_USD = '50';
process.env.CONCURRENCY_LIMIT = '4';
process.env.PER_TASK_TOKEN_CAP = '123456';
process.env.MAX_RETRIES = '5';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.AGENT_IMAGE = 'tractus/agent:custom';
process.env.AGENT_IMAGE_PREFIX = 'custom/agent-';
process.env.AGENT_IDLE_STOP_MS = '1000';
process.env.AGENT_AUTO_SNAPSHOT = '0';
process.env.DISPATCH_TOKEN = 'secret-token';
process.env.DISPATCH_INTERVAL_MS = '0';
process.env.AGENT_DRY_RUN = '1';
process.env.RUN_TIMEOUT_MS = '5000';

const { config, githubConfigured } = await import('../src/config.js');

test('config honours env overrides (non-default branches)', () => {
  assert.equal(config.port, 9999);
  assert.equal(config.github.token, 'ghp_test');
  assert.deepEqual(config.github.repos, ['owner/a', 'owner/b']); // trims + drops blanks
  assert.equal(config.github.botLabel, 'mybot');
  assert.equal(config.budget.dailyLimitUsd, 50);
  assert.equal(config.budget.concurrencyLimit, 4);
  assert.equal(config.budget.perTaskTokenCap, 123456);
  assert.equal(config.maxRetries, 5);
  assert.equal(config.anthropicKey, 'sk-ant-test');
  assert.equal(config.agentImage, 'tractus/agent:custom');
  assert.equal(config.agentImagePrefix, 'custom/agent-');
  assert.equal(config.agentIdleStopMs, 1000);
  assert.equal(config.autoSnapshot, false); // AGENT_AUTO_SNAPSHOT='0'
  assert.equal(config.dispatchToken, 'secret-token');
  assert.equal(config.dispatchIntervalMs, 0);
  assert.equal(config.dryRun, true); // AGENT_DRY_RUN='1'
  assert.equal(config.runTimeoutMs, 5000);
  assert.equal(githubConfigured, true); // token + repos present
});
