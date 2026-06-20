import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh DB before importing db/worker, so applyChatConfig's persistence
// (updateAgent + recordLearning) writes to a throwaway store.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ac-chat-')), 'test.sqlite');
const { createAgent, createProject, getAgent } = await import('../src/db.js');
const { applyChatConfig } = await import('../src/worker.js');
const { MODEL_TIERS } = await import('@tractus/shared');

let agentId: string;

before(() => {
  const project = createProject({ name: 'P', repo: 'o/r' });
  const agent = createAgent({
    projectId: project.id,
    templateId: 'tpl',
    role: 'developer',
    name: 'Ada',
    provider: 'claude-code',
    model: MODEL_TIERS.sonnet,
    dailyBudgetUsd: 5,
    instructions: 'Be concise.',
    skills: [],
  });
  agentId = agent.id;
});

test('applyChatConfig applies instructions, model, budget and skills', () => {
  const agent = getAgent(agentId)!;
  const result = applyChatConfig(agent, {
    instructions: 'Be thorough and write tests.',
    model: MODEL_TIERS.opus,
    dailyBudgetUsd: 12,
    skills: [{ name: 'TDD', content: 'Always red-green-refactor.' }],
  });
  assert.ok(result, 'expected a change to be applied');
  assert.match(result.summary, /instructions/);
  assert.match(result.summary, /model/);
  assert.match(result.summary, /budget/);
  assert.match(result.summary, /skills/);

  const saved = getAgent(agentId)!;
  assert.equal(saved.instructions, 'Be thorough and write tests.');
  assert.equal(saved.model, MODEL_TIERS.opus);
  assert.equal(saved.dailyBudgetUsd, 12);
  assert.equal(saved.skills.length, 1);
  assert.equal(saved.skills[0].name, 'TDD');
  assert.ok(saved.skills[0].id, 'new skill got a stable id');
});

test('applyChatConfig clamps budget and rejects an invalid model', () => {
  const agent = getAgent(agentId)!;
  const result = applyChatConfig(agent, { dailyBudgetUsd: 999, model: 'gpt-4o' });
  assert.ok(result);
  assert.match(result.summary, /budget/);
  assert.doesNotMatch(result.summary, /model/); // invalid model is ignored
  assert.equal(getAgent(agentId)!.dailyBudgetUsd, 50); // clamped to ceiling
  assert.equal(getAgent(agentId)!.model, MODEL_TIERS.opus); // unchanged
});

test('applyChatConfig returns null when nothing actually changes', () => {
  const agent = getAgent(agentId)!;
  const result = applyChatConfig(agent, {
    instructions: agent.instructions,
    name: agent.name,
    dailyBudgetUsd: agent.dailyBudgetUsd,
  });
  assert.equal(result, null);
});

test('applyChatConfig reconciles a renamed skill by name, keeping its id', () => {
  const before = getAgent(agentId)!;
  const skillId = before.skills.find((s) => s.name === 'TDD')!.id;
  const result = applyChatConfig(before, {
    skills: [{ name: 'TDD', content: 'Updated guidance.' }],
  });
  assert.ok(result);
  const saved = getAgent(agentId)!;
  assert.equal(saved.skills[0].id, skillId, 'same skill name keeps its id');
  assert.equal(saved.skills[0].content, 'Updated guidance.');
});
