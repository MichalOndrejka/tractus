import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_PROVIDERS_INFO,
  AGENT_ROLES,
  AGENT_TEMPLATES,
  BACKLOG_STATES,
  STATE_TRANSITIONS,
  canTransition,
  providerInfo,
  type AgentProvider,
} from '../src/index.js';

test('state machine: documented transitions are allowed', () => {
  assert.ok(canTransition('BACKLOG', 'PLANNING'));
  assert.ok(canTransition('PLAN_READY', 'READY'));
  assert.ok(canTransition('READY', 'IN_PROGRESS'));
  assert.ok(canTransition('IN_TESTING', 'IN_REVIEW'));
  assert.ok(canTransition('IN_REVIEW', 'DONE'));
});

test('state machine: illegal transitions are rejected', () => {
  assert.equal(canTransition('DONE', 'READY'), false);
  assert.equal(canTransition('BACKLOG', 'DONE'), false);
  assert.equal(canTransition('READY', 'DONE'), false);
});

test('state machine: every transition references a known state', () => {
  for (const [from, targets] of Object.entries(STATE_TRANSITIONS)) {
    assert.ok(BACKLOG_STATES.includes(from as never), `${from} is a known state`);
    for (const to of targets) {
      assert.ok(BACKLOG_STATES.includes(to), `${from} -> ${to} targets a known state`);
    }
  }
});

test('agent templates are well-formed', () => {
  assert.ok(AGENT_TEMPLATES.length >= 4);
  for (const t of AGENT_TEMPLATES) {
    assert.ok(AGENT_ROLES.includes(t.role), `${t.id}: role is valid`);
    const info = providerInfo(t.provider);
    assert.equal(info.id, t.provider, `${t.id}: provider exists`);
    assert.ok(
      info.models.some((m) => m.id === t.model),
      `${t.id}: model "${t.model}" belongs to provider ${t.provider}`,
    );
    assert.ok(t.instructions.trim().length > 0, `${t.id}: has instructions`);
    assert.ok(t.defaultDailyBudgetUsd >= 0, `${t.id}: non-negative budget`);
  }
});

test('provider catalog: claude-code available, codex not yet, fallback works', () => {
  const cc = providerInfo('claude-code');
  assert.equal(cc.available, true);
  assert.ok(cc.models.length > 0);
  assert.ok(cc.authMethods.includes('subscription'));

  const codex = AGENT_PROVIDERS_INFO.find((p) => p.id === 'codex');
  assert.equal(codex?.available, false);

  // Unknown provider id falls back to the first catalog entry.
  assert.equal(providerInfo('nope' as AgentProvider).id, AGENT_PROVIDERS_INFO[0].id);
});
