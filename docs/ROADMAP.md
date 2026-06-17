# Tractus — Master Plan & Roadmap

> Permanent, version-controlled copy of the architecture and roadmap.
> (The `~/.claude/plans/*.md` files are scratch and get overwritten — this is the
> canonical source of truth, kept in the repo.)

## Vision

An autonomous "software company" of AI agents that continuously pull work from a
backlog and build it (Architect → Developer → Tester → Reviewer), with **you as
Product Owner** approving at gates. Runs locally on your PC; controlled from
desktop and a mobile **PWA**. Project management is the main use case; the
platform stays extensible for other automations later.

## Hard constraints (confirmed)

1. **No paid services** — everything free and self-hosted locally.
2. **Half-agentic for cost** — cheap deterministic automation does routing /
   gating / bookkeeping; LLM tokens are spent only on real work, behind gates.
3. **Agents run in Docker containers** (isolation / security).
4. **Backlog lives in GitHub** (Issues) via API — no separate backlog DB.
5. **One frontend → desktop + mobile PWA**, app-like, futuristic/terminal theme.

## Why a backend is required (not optional)

A PWA is just an installable frontend; it cannot spawn Docker containers, run
git, execute Claude headless, or run long jobs. The backend on the PC is the
thing that *does the work*; the PWA is the remote control. It also provides
shared state across devices and real (server-enforced) auth.

## Architecture

```
 Phone (PWA) + Desktop ──HTTP/WS──▶ Backend (Fastify + SQLite)  ◀── source of truth (process)
                                        │   ▲
                            reads/writes│   │ webhooks
                                        ▼   │
                                  GitHub Issues / PRs            ◀── source of truth (backlog + code)
   n8n (orchestration) ──▶ Worker Manager ──docker run──▶ Agent containers (claude headless)
```

### Components
- **Backend (`apps/backend`)** — Node/TS, Fastify, SQLite, Octokit, WS, cookie
  auth. Owns the process state machine + operational state; serves the PWA.
- **Worker Manager** — launches a Docker container per run (git worktree mounted,
  scoped tools, restricted egress), streams logs, enforces caps, reports PR.
- **Agents (containers)** — short-lived Claude Code headless runs, isolated.
- **n8n (local, Docker)** — deterministic "when X → do Y": dispatch, approvals,
  retries, budget guard, standups. No LLM tokens except optional standup.
- **Frontend (`apps/web`)** — React + Vite PWA (Tauri desktop wrap later).

## Cost model (two tiers)

- **Deterministic (≈ free):** n8n + SQLite — routing, gating, bookkeeping.
- **Cognitive (metered):** Architect/Developer/Tester/Reviewer agents, invoked
  only after a cheap gate passes.
- Model tiers: **Haiku** triage/standups · **Sonnet** build/test · **Opus**
  escalation only.
- Guards: daily $ budget + circuit breaker; per-task token cap + timeout;
  concurrency cap (start 2); cheap-gate-before-expensive; prompt caching.

## Roles & lifecycle

Roles: **Architect/SW-Engineer**, **Software Developer**, **Tester/QA**,
**Auto-Reviewer**; **you = Product Owner**.

State machine (overlaid on GitHub via `state:` labels):
```
BACKLOG → PLANNING → PLAN_READY ─[GATE 1: approve plan]→ READY
READY → IN_PROGRESS → IN_TESTING → IN_REVIEW ─[GATE 2: validate PR]→ DONE
  fail → IN_PROGRESS (retry ≤ N) → BLOCKED ; unrecoverable → FAILED
```
Board groups these into 5 columns: **New · Ready · In Progress · Review · Done**
(agent sub-stage shown as a card tag). Drag-to-rank within a column = priority.

## Mobile / remote

- **Tailscale** (free mesh VPN) to reach the local backend from the phone — no
  public hosting. Backend should serve the built PWA as a single origin.
- **Web Push** for approvals/blocks/standups; optional Telegram bot backup.
- Server-enforced single-owner auth (already built).

## Safety

Per-role tool allow-list; agents in containers with restricted egress; branch
protection (merge only via PO approval); token/time caps; daily budget breaker;
audit log; secrets unreadable by agents.

---

# Phased roadmap & status

### ✅ Phase 0 — Foundations (DONE, plus extras)
- Monorepo: `apps/backend`, `apps/web`, `packages/shared`.
- Backend: Fastify + SQLite + Octokit + WebSocket.
- Backlog read/managed in-app from GitHub Issues ("work items").
- PWA frontend (React + Vite), terminal theme, app-shell.
- **Extras added on request:** single-owner **auth** (signup/login/sessions);
  **multi-project** platform (tiled home → projects → project view);
  **Azure-DevOps board** (5 columns, drag-to-rank = priority, no horizontal
  scroll); **agent customization** (model, budget slider, agent file, skills);
  flush-left project sub-nav.

### ✅ Phase 1 — One agent in a container (DONE, dry-run verified)
- **Worker Manager** in the backend (`apps/backend/src/worker.ts`): on a run
  request launches a **Docker container** for the agent on a work item.
- Agent **Docker image** (`infra/agent/`: git + Claude Code CLI + entrypoint);
  clones the repo, makes a branch, runs the agent, commits/pushes, opens a PR.
- Persists a `run` + streams `log_line`s → WebSocket → live log view on the
  agent page. Per-task timeout; run status; cost field (metering still TODO).
- `POST /api/agents/:id/run { workItemNumber }`; concurrency + budget guard.
- **Dry-run path** (`AGENT_DRY_RUN=1`, no LLM) proven end-to-end.

### ⏳ Phase 2 — n8n + approval gates (IN PROGRESS)
- ✅ **Dispatch (n8n as trigger):** `dispatchTick()` pulls from the Ready column
  (drag-rank = the queue), admission-controlled by `canDispatch()`. n8n triggers
  it on a schedule via `POST /api/dispatch/tick` (shared `DISPATCH_TOKEN`);
  master on/off switch on the board. Infra in `infra/n8n/`.
- ⏳ **Approval gates (NEXT, building now):** **Gate 1 (plan)** — an Architect
  run lands the item in PLAN_READY and opens a pending `plan` approval;
  approving moves it to READY for the **Developer** (role-aware dispatch checks
  for an approved plan). **Gate 2 (merge)** — a Developer run lands it in
  IN_REVIEW with a pending `merge` approval; approving → DONE. Approve/reject in
  the board's Review column. Mobile push = Phase 4.

### ✅ Phase 3 — Full crew (DONE)
The dispatcher now drives the whole chain — Architect → Developer → Tester →
Auto-Reviewer — across the board states (READY / IN_TESTING / IN_REVIEW),
skipping items already in flight. Routing adapts to which roles are deployed:
Developer-done goes to IN_TESTING only if a Tester exists, else straight to the
merge gate; the Auto-Reviewer is advisory (posts a summary at the merge gate,
runs once, never changes state). Failure retries are capped (→ BLOCKED).
Remaining for later: parsing tester pass/fail to gate on results, and explicit
task dependencies.

### Phase 4 — Hardening & mobile
Budget dashboard + circuit breaker (real enforcement); standups; Telegram;
container egress lockdown; **Tailscale** + backend-serves-PWA single origin;
optional **Tauri** desktop wrap.

---

## Current honest status (snapshot)

- The **cockpit is built** and the **engine runs**: agents execute in Docker
  containers, stream live logs, move work items through the board, and an
  auto-dispatcher (n8n-triggered) pulls from Ready.
- **In progress:** the approval gates (Gate 1 plan / Gate 2 merge) that connect
  Architect → Developer with you approving between them.
- **Phase 2 hardened:** retry cap (failed runs park in BLOCKED after
  `MAX_RETRIES`, no infinite loop); PR URL captured from the run and surfaced on
  the merge gate; usage/cost captured into the run + daily budget ledger, and
  per-agent `spentTodayUsd` is real (sums run costs). Cost is naturally 0 under a
  Claude Code subscription (flat-rate); it populates for API-key usage once the
  CLI emits usage.
- **Still TODO:** full token parsing from the Claude CLI (needs JSON output
  mode); container egress lockdown + tool allow-list; mobile/remote (Tailscale +
  Web Push); Tauri wrap.
- **Next step:** Phase 3 — Tester + Auto-Reviewer in the pipeline.

## Stack reference

Backend: Node/TS, Fastify, better-sqlite3, @octokit/rest, @fastify/cookie
(scrypt sessions), @fastify/websocket. Frontend: React 18, Vite, react-router,
@dnd-kit, vite-plugin-pwa. Data: local SQLite (`data/tractus.sqlite`);
backlog from GitHub. Dev: `npm run dev` (backend :8787 + Vite :5173 proxy).

Tests: `npm test` (root, runs all workspaces) — 37 tests on Node's `node:test`
runner via `tsx`, **no extra deps**. Coverage via `--experimental-test-coverage`
with an enforced **80% line gate** (`--test-coverage-lines=80`); `npm test`
exits non-zero below it. Current: shared ~99% lines, backend ~87% lines.
- `packages/shared/test` — state machine + provider catalog.
- `apps/backend/test` — `pipeline.test.ts` (pure routing/decisions, 100%),
  `state.test.ts` (GitHub label parsing, 100%), `db.test.ts` (db logic vs a
  temp SQLite), `http.test.ts` (routes + auth via Fastify `app.inject()`).
- The pure decision logic lives in `src/pipeline.ts` (testable); `worker.ts`
  (Docker), `github.ts` (network) and `ws.ts` are the I/O shells, excluded from
  the coverage gate. `index.ts` exports `app` and only listens under
  `import.meta.main`, so tests inject without binding a port.
- Tests live under `test/` (outside tsconfig `src` include — no build impact).
