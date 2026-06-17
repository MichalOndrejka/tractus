import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the db at a throwaway SQLite file BEFORE importing it (config reads the
// env at module load). Dynamic import guarantees the ordering.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ac-test-')), 'test.sqlite');
const db = await import('../src/db.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('createAgent stores provider + model and lists', () => {
  const p = db.createProject({ name: 'P', repo: 'o/r' });
  const a = db.createAgent({
    projectId: p.id,
    templateId: 'developer',
    role: 'developer',
    name: 'Dev',
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    dailyBudgetUsd: 5,
    instructions: 'do the thing',
    skills: [],
  });
  assert.equal(a.provider, 'claude-code');
  assert.equal(a.model, 'claude-sonnet-4-6');
  assert.equal(a.status, 'idle');
  const list = db.listAgents(p.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, a.id);
});

test('approval gate lifecycle (reuse pending, decide, hasApprovedPlan)', () => {
  const repo = 'o/appr';
  const n = 1;
  const ap = db.createApproval({ repo, issueNumber: n, gate: 'plan' });
  assert.equal(ap.state, 'pending');

  // A second create reuses the existing pending approval rather than duplicating.
  const ap2 = db.createApproval({ repo, issueNumber: n, gate: 'plan' });
  assert.equal(ap2.id, ap.id);

  assert.equal(db.hasApprovedPlan(repo, n), false);
  assert.equal(db.pendingApprovalFor(repo, n)?.id, ap.id);

  const decided = db.decideApproval(ap.id, 'approved', 'lgtm');
  assert.equal(decided?.state, 'approved');
  assert.equal(decided?.comment, 'lgtm');
  assert.equal(db.hasApprovedPlan(repo, n), true);
  assert.equal(db.pendingApprovalFor(repo, n), undefined);
});

test('recentFailureStreak counts trailing failures until a success', async () => {
  const repo = 'o/runs';
  const n = 7;
  const mk = (id: string) =>
    db.createRun({ id, repo, issueNumber: n, role: 'developer', model: 'm' });

  mk('a:1');
  db.finishRun('a:1', 'failed');
  await sleep(4);
  mk('a:2');
  db.finishRun('a:2', 'failed');
  await sleep(4);
  assert.equal(db.recentFailureStreak(repo, n), 2);

  mk('a:3');
  db.finishRun('a:3', 'done');
  await sleep(4);
  assert.equal(db.recentFailureStreak(repo, n), 0);

  mk('a:4');
  db.finishRun('a:4', 'failed');
  assert.equal(db.recentFailureStreak(repo, n), 1);
});

test('hasCompletedRunForRole is role-scoped', () => {
  const repo = 'o/role';
  const n = 3;
  db.createRun({ id: 'rev:1', repo, issueNumber: n, role: 'reviewer', model: 'm' });
  assert.equal(db.hasCompletedRunForRole(repo, n, 'reviewer'), false); // still running
  db.finishRun('rev:1', 'done');
  assert.equal(db.hasCompletedRunForRole(repo, n, 'reviewer'), true);
  assert.equal(db.hasCompletedRunForRole(repo, n, 'tester'), false);
});

test('finishRun captures PR url, tokens and cost; latestPrUrlForItem', () => {
  const repo = 'o/pr';
  const n = 9;
  db.createRun({ id: 'dev:pr', repo, issueNumber: n, role: 'developer', model: 'm' });
  const finished = db.finishRun('dev:pr', 'done', {
    prUrl: 'https://github.com/o/pr/pull/1',
    costUsd: 0.42,
    tokensIn: 100,
    tokensOut: 50,
  });
  assert.equal(finished?.prUrl, 'https://github.com/o/pr/pull/1');
  assert.equal(finished?.costUsd, 0.42);
  assert.equal(finished?.tokensIn, 100);
  assert.equal(db.latestPrUrlForItem(repo, n), 'https://github.com/o/pr/pull/1');
});

test('addBudgetCost accumulates into the daily ledger', () => {
  const before = db.getBudgetStatus(0).costUsd;
  db.addBudgetCost(100, 50, 0.42);
  const after = db.getBudgetStatus(0);
  assert.ok(after.costUsd >= before + 0.42 - 1e-9);
  assert.equal(after.dailyLimitUsd, 10); // default when no env override
});

test('spentTodayUsd reflects an agent run cost', () => {
  const p = db.createProject({ name: 'B', repo: 'o/spend' });
  const a = db.createAgent({
    projectId: p.id,
    templateId: 'developer',
    role: 'developer',
    name: 'D',
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    dailyBudgetUsd: 5,
    instructions: 'x',
    skills: [],
  });
  db.createRun({ id: `${a.id}:r1`, repo: 'o/spend', issueNumber: 1, role: 'developer', model: 'm' });
  db.finishRun(`${a.id}:r1`, 'done', { costUsd: 1.25 });
  assert.equal(db.getAgent(a.id)?.spentTodayUsd, 1.25);
});

test('setOrder / getPositions persist drag-rank', () => {
  const p = db.createProject({ name: 'O', repo: 'o/ord' });
  db.setOrder(p.id, [5, 9, 2]);
  const pos = db.getPositions(p.id);
  assert.equal(pos.get(5), 0);
  assert.equal(pos.get(9), 1);
  assert.equal(pos.get(2), 2);
});

test('provider connection store / read / clear', () => {
  assert.equal(db.getProviderConnection('claude-code'), undefined);
  db.setProviderConnection('claude-code', { method: 'subscription', token: 'sk-oat-xyz' });
  const c = db.getProviderConnection('claude-code');
  assert.equal(c?.method, 'subscription');
  assert.equal(c?.token, 'sk-oat-xyz');
  db.clearProviderConnection('claude-code');
  assert.equal(db.getProviderConnection('claude-code'), undefined);
});
