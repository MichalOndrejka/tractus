/**
 * Pure pipeline decisions — no I/O, so they're unit-testable in isolation.
 * worker.ts is the thin Docker/stream/broadcast shell that calls into these.
 */
import type { AgentRole, BacklogState } from '@tractus/shared';

/** Column an item enters when an agent first picks it up from Ready/New. */
export function pickupState(role: AgentRole): BacklogState {
  return role === 'architect' ? 'PLANNING' : 'IN_PROGRESS';
}

/**
 * Which role should act on an item next given its state + history, or null if
 * nobody auto-acts (it's human-gated, done, or already reviewed).
 */
export function nextRoleForItem(
  state: BacklogState,
  ctx: { planApproved: boolean; reviewerDone: boolean },
): AgentRole | null {
  switch (state) {
    case 'READY':
      return ctx.planApproved ? 'developer' : 'architect';
    case 'IN_TESTING':
      return 'tester';
    case 'IN_REVIEW':
      return ctx.reviewerDone ? null : 'reviewer';
    default:
      return null;
  }
}

export interface ExitRoute {
  state: BacklogState;
  gate: 'plan' | 'merge' | null;
}

/**
 * Where a finished run sends its item, and which human gate (if any) to open.
 * Returns null for the Auto-Reviewer: it is advisory and never changes state.
 *
 *   architect ✓ -> PLAN_READY + plan gate
 *   developer ✓ -> IN_TESTING (if a Tester is deployed) else IN_REVIEW + merge
 *   tester    ✓ -> IN_REVIEW + merge gate
 *   any role  ✗ -> READY (retry), or BLOCKED once failures exceed maxRetries
 */
export function routeAfterRun(input: {
  role: AgentRole;
  ok: boolean;
  failureStreak: number;
  maxRetries: number;
  hasTester: boolean;
}): ExitRoute | null {
  const { role, ok, failureStreak, maxRetries, hasTester } = input;
  if (role === 'reviewer') return null;
  if (!ok) {
    return { state: failureStreak > maxRetries ? 'BLOCKED' : 'READY', gate: null };
  }
  if (role === 'architect') return { state: 'PLAN_READY', gate: 'plan' };
  if (role === 'developer') {
    return hasTester ? { state: 'IN_TESTING', gate: null } : { state: 'IN_REVIEW', gate: 'merge' };
  }
  return { state: 'IN_REVIEW', gate: 'merge' }; // tester
}

/** Whether an agent still has daily budget headroom (0/unset = unlimited). */
export function isWithinBudget(a: { dailyBudgetUsd: number; spentTodayUsd: number }): boolean {
  return a.dailyBudgetUsd <= 0 || a.spentTodayUsd < a.dailyBudgetUsd;
}

/** What the supervisor found when it (re)inspected a run's container. */
export type ContainerStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number }
  | { kind: 'gone' };

export interface ReconcileDecision {
  /** 'reattach': stream + wait on the live container; 'finalize': close it out now. */
  action: 'reattach' | 'finalize';
  /** For 'finalize': did the run succeed (drives routeAfterRun)? */
  ok: boolean;
  /** For 'finalize': the terminal run status to persist. */
  status: 'done' | 'failed' | 'killed';
}

/**
 * Decide how startup reconciliation should treat an orphaned `running` run given
 * its container's current state:
 *   still running -> re-attach (resume supervising; lose nothing)
 *   exited(0)     -> finalize as done
 *   exited(!=0)   -> finalize as failed
 *   gone          -> finalize as killed (container vanished while we were down)
 */
export function reconcileDecision(c: ContainerStatus): ReconcileDecision {
  if (c.kind === 'running') return { action: 'reattach', ok: false, status: 'failed' };
  if (c.kind === 'gone') return { action: 'finalize', ok: false, status: 'killed' };
  const ok = c.exitCode === 0;
  return { action: 'finalize', ok, status: ok ? 'done' : 'failed' };
}
