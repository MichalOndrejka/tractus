#!/usr/bin/env bash
# One agent run, executed via `docker exec` inside a *persistent* agent container.
# Inputs come from environment variables passed on the exec (see worker.ts):
#   DRY_RUN=1            -> simulate only; no clone/commit/push/PR, no LLM, no cost
#   REPO=owner/name      GITHUB_TOKEN, DEFAULT_BRANCH
#   ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY
#   AGENT_ROLE, INSTRUCTIONS, MODEL_ID
#   PROVIDER             -> agentic system to run (claude-code | codex | ...)
#   ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN -> Claude Code auth (API or sub)
#   CONDUIT_MCP_URL / CONDUIT_API_KEY            -> memory (wired in Phase 2)
#
# Restart-safety contract with the supervisor:
#   - PID written to /work/run.pid at start
#   - all output tee'd to /work/run.log (so a reattached supervisor can stream it)
#   - the final line is `::exit::<code>` and the code is also written to
#     /work/run.status, so completion survives a backend restart.
set -uo pipefail

# Fresh per-run markers, then mirror everything to the durable run log.
: > /work/run.log
rm -f /work/run.status
echo $$ > /work/run.pid
exec > >(tee -a /work/run.log) 2>&1

# Emit the completion sentinel + status on ANY exit (success, error, or `exit N`).
# Also scrub run-scoped secrets so a snapshot taken while idle stays clean:
#   - the conduit MCP config (holds the bearer key)
#   - the GitHub token baked into the cached clone's remote URL
finish() {
  local rc=$?
  rm -f /work/.mcp.json
  [ -n "${REPO:-}" ] && git -C "/work/repos/${REPO}" remote set-url origin \
    "https://github.com/${REPO}.git" 2>/dev/null
  echo "::exit::${rc}"
  echo "${rc}" > /work/run.status
}
trap finish EXIT

log() { echo "[agent] $*"; }

run() {
  # ---- dry run: prove the pipeline without side effects -------------------
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY RUN — no repository changes, no tokens spent"
    log "role=${AGENT_ROLE:-developer} model=${MODEL_ID:-n/a}"
    log "work item #${ISSUE_NUMBER:-?}: ${ISSUE_TITLE:-}"
    log "step 1/5 sync ${REPO:-<repo>} (simulated)"; sleep 1
    log "step 2/5 create branch agent/${ISSUE_NUMBER:-x} (simulated)"; sleep 1
    log "step 3/5 run agent instructions (simulated)"; sleep 1
    log "step 4/5 commit + push (simulated)"; sleep 1
    log "step 5/5 open pull request (simulated)"; sleep 1
    log "DONE (dry run)"
    return 0
  fi

  # ---- real run -----------------------------------------------------------
  : "${REPO:?REPO required}"
  : "${GITHUB_TOKEN:?GITHUB_TOKEN required}"
  : "${ISSUE_NUMBER:?ISSUE_NUMBER required}"
  local branch="agent/${ISSUE_NUMBER}-${AGENT_ROLE:-dev}"
  local base="${DEFAULT_BRANCH:-main}"
  local repo_dir="/work/repos/${REPO}"
  local origin="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"

  # Reuse a cached clone across runs; only fetch the delta. First run clones.
  if [ -d "${repo_dir}/.git" ]; then
    log "syncing cached clone of ${REPO}"
    cd "${repo_dir}" || { log "cannot enter cache dir"; return 1; }
    git remote set-url origin "${origin}"
    git fetch --depth 1 origin "${base}" || { log "fetch failed"; return 1; }
  else
    log "cloning ${REPO}"
    mkdir -p "$(dirname "${repo_dir}")"
    git clone --depth 1 --branch "${base}" "${origin}" "${repo_dir}" || { log "clone failed"; return 1; }
    cd "${repo_dir}" || { log "cannot enter clone dir"; return 1; }
  fi

  git config user.email "agent@tractus.local"
  git config user.name "Tractus"
  # Start each run from a clean base branch tip.
  git checkout -B "${base}" "origin/${base}"
  git reset --hard "origin/${base}"
  git clean -fd
  git checkout -B "${branch}"

  # Shared team memory (conduit) over MCP, when connected. All agents read+write
  # one pooled experience store, so a lesson learned by one helps the rest.
  local memory_preamble=""
  if [ -n "${CONDUIT_MCP_URL:-}" ]; then
    log "memory: conduit connected (${CONDUIT_MCP_URL})"
    cat > /work/.mcp.json <<EOF
{ "mcpServers": { "conduit": { "type": "http", "url": "${CONDUIT_MCP_URL}",
  "headers": { "Authorization": "Bearer ${CONDUIT_API_KEY:-}" } } } }
EOF
    memory_preamble="$(cat <<'EOF'
You share a team memory via the "conduit" MCP server — one pool across all agents.
BEFORE starting: call retrieve_experience with a description of this work item to
recall relevant lessons, and use search_source_code / search_test_code /
search_documentation for context from the codebase and docs.
AFTER finishing: call remember exactly once with a concise (situation, guidance)
pair capturing a durable, reusable lesson. Make the situation self-describing
(mention the kind of work and any tech/repo specifics) since the memory is shared.
Never store secrets.

EOF
)"
  fi

  local prompt
  prompt="$(printf '%s%s\n\n--- Work item #%s ---\nTitle: %s\n\n%s\n' \
    "${memory_preamble}" "${INSTRUCTIONS:-}" "${ISSUE_NUMBER}" "${ISSUE_TITLE:-}" "${ISSUE_BODY:-}")"

  local provider="${PROVIDER:-claude-code}"
  log "provider=${provider}"

  run_placeholder() {
    log "$1 — writing a placeholder change instead of doing real work"
    printf '\n- agent (%s) processed work item #%s: %s\n' \
      "${provider}" "${ISSUE_NUMBER}" "${ISSUE_TITLE:-}" >> AGENT_NOTES.md
  }

  case "${provider}" in
    claude-code)
      if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        log "running claude (${MODEL_ID:-default})"
        local claude_args=(-p --permission-mode acceptEdits)
        [ -n "${MODEL_ID:-}" ] && claude_args+=(--model "${MODEL_ID}")
        if [ -f /work/.mcp.json ]; then
          # Allow all tools from the conduit MCP server (server-level grant).
          claude_args+=(--mcp-config /work/.mcp.json --allowedTools "mcp__conduit")
        fi
        printf '%s' "${prompt}" | claude "${claude_args[@]}" || log "claude exited non-zero"
      else
        run_placeholder "no Claude Code credentials (connect a subscription token or API key)"
      fi
      ;;
    *)
      run_placeholder "provider '${provider}' is not supported by this agent image yet"
      ;;
  esac

  # Stage first, THEN check — `git diff` alone ignores new untracked files.
  git add -A
  if git diff --cached --quiet; then
    log "no changes were produced; nothing to push"
    return 0
  fi

  git commit -m "agent: work item #${ISSUE_NUMBER} ${ISSUE_TITLE:-}" >/dev/null
  log "pushing ${branch}"
  git push -f -u origin "${branch}" || { log "push failed"; return 1; }

  log "opening pull request"
  local pr_body pr_resp pr_url
  pr_body="$(jq -n \
    --arg t "Agent: #${ISSUE_NUMBER} ${ISSUE_TITLE:-}" \
    --arg h "${branch}" \
    --arg b "${base}" \
    --arg body "Automated by Tractus for work item #${ISSUE_NUMBER}." \
    '{title:$t, head:$h, base:$b, body:$body}')"
  pr_resp="$(curl -sS -X POST \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/pulls" \
    -d "${pr_body}")"
  pr_url="$(printf '%s' "${pr_resp}" | jq -r '.html_url // empty')"
  if [ -n "${pr_url}" ]; then
    echo "::pr::${pr_url}"   # sentinel parsed by the worker
  else
    log "PR not created: $(printf '%s' "${pr_resp}" | jq -r '.message // "unknown error"')"
  fi
  log "DONE"
  return 0
}

run
