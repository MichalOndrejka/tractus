# Tractus — Session Handoff

> Paste this into a new chat to bootstrap context. Canonical plan: `docs/ROADMAP.md`.

## What this is
**Tractus**: a local, autonomous "software company" of AI agents that pull work
from a GitHub-backed backlog and build it (Architect → Developer → Tester → Auto-Reviewer),
with **you (Product Owner)** approving at gates. Backend on your PC does the work; a React
**PWA** is the remote control. Constraints: no paid services, half-agentic (deterministic
glue free; LLM tokens only on real work behind gates), agents run in Docker, backlog lives
in GitHub Issues, futuristic/terminal UI.

## Location & how to run
- **Project root: `C:\Users\Michal\repos\tractus`** (a git repo; moved from `repos\temp`).
  After the move, `npm install` was rerun to repair Windows workspace junctions.
- `npm run dev` → backend (Fastify) on :8787 + Vite PWA on :5173 (proxies `/api` + `/ws`).
  **Backend cwd is `apps/backend`, so the live DB is `apps/backend/data/tractus.sqlite`.**
- `npm test` → 37 tests, enforces **80% line coverage** (exits non-zero below).
- Agent image: `docker build -t tractus/agent:latest infra/agent`.
- n8n (dispatch trigger): `cd infra/n8n && docker compose up -d` (see its README).

## Stack
Node/TS monorepo (npm workspaces): `packages/shared` (domain types + state machine + provider
catalog), `apps/backend` (Fastify + better-sqlite3 + Octokit + WS + scrypt cookie auth),
`apps/web` (React 18 + Vite + @dnd-kit + vite-plugin-pwa). Docker agent image in `infra/agent`,
n8n in `infra/n8n`.

## Done (Phases 0–3 + extras)
- **Phase 0** — monorepo, single-owner auth (signup locks after first), multi-project
  (tiled Home → projects → Board/Agents), Azure-DevOps **5-column board** (New/Ready/In
  Progress/Review/Done), drag-to-rank = priority, agent customization (provider, model,
  budget, agent-file, skills).
- **Phase 1** — agents run in **Docker** (`infra/agent`): clone → branch → run CLI →
  commit → push → PR; live log streaming over WS; `AGENT_DRY_RUN=1` simulates for free.
- **Phase 2** — **auto-dispatch** (n8n calls `POST /api/dispatch/tick` with `DISPATCH_TOKEN`;
  Ready column = queue, `canDispatch()` = concurrency/budget admission; board on/off toggle).
  **Approval gates**: Architect → (approve plan / Gate 1) → Developer → (approve merge /
  Gate 2) → Done, approve/reject from the Review column. **Hardening**: retry cap
  (`MAX_RETRIES`, default 2 → BLOCKED), PR URL captured onto the run + merge gate, run
  usage/cost → daily budget ledger + per-agent `spentTodayUsd`.
- **Phase 3** — full crew. Dispatcher drives Architect→Developer→Tester→Auto-Reviewer across
  READY/IN_TESTING/IN_REVIEW, skipping in-flight items. **Adaptive**: developer-done →
  IN_TESTING only if a Tester is deployed, else straight to the merge gate (so an
  Architect+Developer-only roster still works). **Auto-Reviewer is advisory** — posts a
  summary, runs once, never changes state.
- **Providers** — per-agent **provider** (the agentic system in the container). `claude-code`
  available; `codex` scaffolded/coming-soon. Connect creds in **Home → Providers**:
  Claude Code via **subscription token** (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`)
  or **API key** (`ANTHROPIC_API_KEY`). Injected per run by provider.
- **Tests** — `node:test` + `tsx`, no new deps. 80% line gate. Pure decision logic in
  `apps/backend/src/pipeline.ts` (100% covered); `index.ts` exports `app` + listens only
  under `import.meta.main` so tests use `app.inject()`. Coverage excludes the I/O shells
  `worker.ts`/`github.ts`/`ws.ts`.

## Key files
- `packages/shared/src/index.ts` — states + `STATE_TRANSITIONS`/`canTransition`, roles,
  `AGENT_PROVIDERS_INFO`/`providerInfo`, `AGENT_TEMPLATES`, `BacklogItem`/`DeployedAgent`/
  `Run`/`Approval`/`WsEvent`.
- `apps/backend/src/pipeline.ts` — pure: `pickupState`, `nextRoleForItem`, `routeAfterRun`,
  `isWithinBudget`.
- `apps/backend/src/worker.ts` — `dispatchTick`, `launchRun`, `runAgentOnItem` (Docker spawn +
  log stream + `::pr::`/`::usage::` sentinel parsing), `canDispatch`.
- `apps/backend/src/db.ts` — SQLite; agents/projects/runs/approvals/budget/positions/provider
  connections; migrations.
- `apps/backend/src/index.ts` — all routes; `app` exported.
- `apps/backend/src/{auth,github,state,ws,config}.ts`.
- `apps/web/src/components/ProjectBoard.tsx` (board + gate approve/reject),
  `AgentForm.tsx` (provider/model), `pages/Providers.tsx`, `api.ts`, `pages/*`.
- `infra/agent/{Dockerfile,entrypoint.sh}`, `infra/n8n/*`, `docs/ROADMAP.md`.

## Current setup state
- `.env` and `data/` (your owner account, GitHub PAT, any provider connection, agents) moved
  with the app and are gitignored.
- To do real (non-placeholder) work you must connect a provider: **Home → Providers →
  Claude Code** (subscription token recommended — you have a subscription). Without it (and
  without `ANTHROPIC_API_KEY`), runs write a placeholder commit only.
- `tractus` is a git repo with nothing committed yet; `.gitignore` already excludes
  `node_modules/`, `dist/`, `.env`, `data/`.

## To be done (next)
1. **Tester pass/fail gating** — today "tester ran" advances to review; parse a result
   sentinel (like `::pr::`) so failing tests bounce back instead of advancing. Do before
   trusting unattended runs.
2. **Full token/cost parsing** — wire Claude CLI JSON output to emit `::usage::` so cost is
   real for API-key usage (subscription is flat $0, so this is API-key-only value).
3. **Phase 4 — hardening & mobile**: real budget dashboard + enforced circuit breaker;
   container egress lockdown + per-role tool allow-list; **Tailscale** + backend serving the
   built PWA (single origin) for phone access; **Web Push** for approvals; optional **Tauri**
   desktop wrap.
4. **Explicit task dependencies** between work items.
5. **Concurrency**: overlapping `dispatchTick` calls (n8n timer + manual) could race to pick
   the same Ready item before it moves to IN_PROGRESS — add a short lock/claim. Low risk at
   60s cadence.
6. **Optional test depth**: mock Octokit + `child_process` to cover `github.ts`/`worker.ts`
   and the GitHub route happy-paths in `index.ts`.
7. **First commit**: `git init` not needed (already a repo); `git add -A && git commit`.

## Gotchas
- Live DB is `apps/backend/data/...`, not root `data/` (backend cwd).
- `node_modules` is not portable across a move — rerun `npm install` if relocating.
- **Auto-dispatch is ON by default** (only an explicit toggle-off persists `'false'`), and the
  backend runs its own dispatch pass every `DISPATCH_INTERVAL_MS` (default 15s) — n8n is now
  optional. Free agent + READY item ⇒ auto-pickup within a tick.
- **Restart-safe runs**: agent containers run **detached** (`docker run -d`, no `--rm`, name
  `ac-<runId>`) so they outlive a backend restart. On boot, `reconcileRunningRuns()` re-attaches
  to still-running containers (streaming logs from the start to re-capture `::pr::`/`::usage::`)
  and finalizes the rest (done/failed/killed → frees the agent, routes the item). Containers are
  `docker rm -f`'d once their result is harvested. The run timeout is a wall-clock deadline
  anchored to `started_at`, so it survives restarts too.
- This handoff's memory/transcript are keyed to the old `repos\temp` path; a session opened in
  `tractus` starts fresh unless the `~/.claude/projects/...-temp` store is copied to the
  `...-tractus` key.
