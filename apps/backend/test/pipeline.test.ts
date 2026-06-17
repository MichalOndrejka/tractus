import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWithinBudget,
  nextRoleForItem,
  pickupState,
  reconcileDecision,
  routeAfterRun,
} from '../src/pipeline.js';

test('pickupState: architect plans, others implement', () => {
  assert.equal(pickupState('architect'), 'PLANNING');
  assert.equal(pickupState('developer'), 'IN_PROGRESS');
  assert.equal(pickupState('tester'), 'IN_PROGRESS');
  assert.equal(pickupState('reviewer'), 'IN_PROGRESS');
});

test('nextRoleForItem: READY routes by plan approval', () => {
  assert.equal(nextRoleForItem('READY', { planApproved: false, reviewerDone: false }), 'architect');
  assert.equal(nextRoleForItem('READY', { planApproved: true, reviewerDone: false }), 'developer');
});

test('nextRoleForItem: testing/review stages', () => {
  assert.equal(nextRoleForItem('IN_TESTING', { planApproved: true, reviewerDone: false }), 'tester');
  assert.equal(nextRoleForItem('IN_REVIEW', { planApproved: true, reviewerDone: false }), 'reviewer');
  assert.equal(nextRoleForItem('IN_REVIEW', { planApproved: true, reviewerDone: true }), null);
});

test('nextRoleForItem: non-dispatchable states yield null', () => {
  for (const s of ['BACKLOG', 'PLANNING', 'PLAN_READY', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'FAILED'] as const) {
    assert.equal(nextRoleForItem(s, { planApproved: true, reviewerDone: false }), null, s);
  }
});

test('routeAfterRun: architect success opens the plan gate', () => {
  assert.deepEqual(
    routeAfterRun({ role: 'architect', ok: true, failureStreak: 0, maxRetries: 2, hasTester: true }),
    { state: 'PLAN_READY', gate: 'plan' },
  );
});

test('routeAfterRun: developer routes to testing only when a Tester exists', () => {
  assert.deepEqual(
    routeAfterRun({ role: 'developer', ok: true, failureStreak: 0, maxRetries: 2, hasTester: true }),
    { state: 'IN_TESTING', gate: null },
  );
  assert.deepEqual(
    routeAfterRun({ role: 'developer', ok: true, failureStreak: 0, maxRetries: 2, hasTester: false }),
    { state: 'IN_REVIEW', gate: 'merge' },
  );
});

test('routeAfterRun: tester success opens the merge gate', () => {
  assert.deepEqual(
    routeAfterRun({ role: 'tester', ok: true, failureStreak: 0, maxRetries: 2, hasTester: true }),
    { state: 'IN_REVIEW', gate: 'merge' },
  );
});

test('routeAfterRun: reviewer is advisory (null) on success and failure', () => {
  assert.equal(routeAfterRun({ role: 'reviewer', ok: true, failureStreak: 0, maxRetries: 2, hasTester: true }), null);
  assert.equal(routeAfterRun({ role: 'reviewer', ok: false, failureStreak: 9, maxRetries: 2, hasTester: true }), null);
});

test('routeAfterRun: failures retry then block past the cap', () => {
  assert.deepEqual(
    routeAfterRun({ role: 'developer', ok: false, failureStreak: 1, maxRetries: 2, hasTester: false }),
    { state: 'READY', gate: null },
  );
  assert.deepEqual(
    routeAfterRun({ role: 'developer', ok: false, failureStreak: 2, maxRetries: 2, hasTester: false }),
    { state: 'READY', gate: null },
  );
  assert.deepEqual(
    routeAfterRun({ role: 'developer', ok: false, failureStreak: 3, maxRetries: 2, hasTester: false }),
    { state: 'BLOCKED', gate: null },
  );
});

test('reconcileDecision: re-attach when the container is still running', () => {
  assert.deepEqual(reconcileDecision({ kind: 'running' }), {
    action: 'reattach',
    ok: false,
    status: 'failed',
  });
});

test('reconcileDecision: finalize exited containers by their exit code', () => {
  assert.deepEqual(reconcileDecision({ kind: 'exited', exitCode: 0 }), {
    action: 'finalize',
    ok: true,
    status: 'done',
  });
  assert.deepEqual(reconcileDecision({ kind: 'exited', exitCode: 137 }), {
    action: 'finalize',
    ok: false,
    status: 'failed',
  });
});

test('reconcileDecision: a vanished container is finalized as killed', () => {
  assert.deepEqual(reconcileDecision({ kind: 'gone' }), {
    action: 'finalize',
    ok: false,
    status: 'killed',
  });
});

test('isWithinBudget: unlimited when budget is 0, else compares spend', () => {
  assert.equal(isWithinBudget({ dailyBudgetUsd: 0, spentTodayUsd: 999 }), true);
  assert.equal(isWithinBudget({ dailyBudgetUsd: 5, spentTodayUsd: 4.99 }), true);
  assert.equal(isWithinBudget({ dailyBudgetUsd: 5, spentTodayUsd: 5 }), false);
  assert.equal(isWithinBudget({ dailyBudgetUsd: 5, spentTodayUsd: 7 }), false);
});
