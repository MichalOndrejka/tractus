#!/usr/bin/env bash
# Single agent run. Inputs come from environment variables (see worker.ts).
#   DRY_RUN=1            -> simulate only; no clone/commit/push/PR, no LLM, no cost
#   REPO=owner/name      GITHUB_TOKEN, DEFAULT_BRANCH
#   ISSUE_NUMBER, ISSUE_TITLE, ISSUE_BODY
#   AGENT_ROLE, INSTRUCTIONS, MODEL_ID
#   PROVIDER             -> agentic system to run (claude-code | codex | ...)
#   ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN -> Claude Code auth (API or sub)
#   (no auth / unsupported provider -> writes a placeholder change)
set -uo pipefail

log() { echo "[agent] $*"; }

# ---- dry run: prove the pipeline without side effects ---------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN — no repository changes, no tokens spent"
  log "role=${AGENT_ROLE:-developer} model=${MODEL_ID:-n/a}"
  log "work item #${ISSUE_NUMBER:-?}: ${ISSUE_TITLE:-}"
  log "step 1/5 clone ${REPO:-<repo>} (simulated)"; sleep 1
  log "step 2/5 create branch agent/${ISSUE_NUMBER:-x} (simulated)"; sleep 1
  log "step 3/5 run agent instructions (simulated)"; sleep 1
  log "step 4/5 commit + push (simulated)"; sleep 1
  log "step 5/5 open pull request (simulated)"; sleep 1
  log "DONE (dry run)"
  exit 0
fi

# ---- real run -------------------------------------------------------------
: "${REPO:?REPO required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER required}"
BRANCH="agent/${ISSUE_NUMBER}-${AGENT_ROLE:-dev}"

log "cloning ${REPO}"
git clone --depth 1 "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" repo || {
  log "clone failed"; exit 1; }
cd repo
git config user.email "agent@tractus.local"
git config user.name "Tractus"
git checkout -b "${BRANCH}"

PROMPT="$(printf '%s\n\n--- Work item #%s ---\nTitle: %s\n\n%s\n' \
  "${INSTRUCTIONS:-}" "${ISSUE_NUMBER}" "${ISSUE_TITLE:-}" "${ISSUE_BODY:-}")"

PROVIDER="${PROVIDER:-claude-code}"
log "provider=${PROVIDER}"

run_placeholder() {
  log "$1 — writing a placeholder change instead of doing real work"
  printf '\n- agent (%s) processed work item #%s: %s\n' \
    "${PROVIDER}" "${ISSUE_NUMBER}" "${ISSUE_TITLE:-}" >> AGENT_NOTES.md
}

case "${PROVIDER}" in
  claude-code)
    # `claude` picks up CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY automatically.
    if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      log "running claude (${MODEL_ID:-default})"
      printf '%s' "${PROMPT}" | claude -p \
        --permission-mode acceptEdits \
        ${MODEL_ID:+--model "${MODEL_ID}"} \
        || log "claude exited non-zero"
    else
      run_placeholder "no Claude Code credentials (connect a subscription token or API key)"
    fi
    ;;
  *)
    run_placeholder "provider '${PROVIDER}' is not supported by this agent image yet"
    ;;
esac

# Stage first, THEN check — `git diff` alone ignores new untracked files.
git add -A
if git diff --cached --quiet; then
  log "no changes were produced; nothing to push"
  exit 0
fi

git commit -m "agent: work item #${ISSUE_NUMBER} ${ISSUE_TITLE:-}" >/dev/null
log "pushing ${BRANCH}"
git push -u origin "${BRANCH}" || { log "push failed"; exit 1; }

log "opening pull request"
PR_BODY="$(jq -n \
  --arg t "Agent: #${ISSUE_NUMBER} ${ISSUE_TITLE:-}" \
  --arg h "${BRANCH}" \
  --arg b "${DEFAULT_BRANCH:-main}" \
  --arg body "Automated by Tractus for work item #${ISSUE_NUMBER}." \
  '{title:$t, head:$h, base:$b, body:$body}')"
PR_RESP="$(curl -sS -X POST \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/pulls" \
  -d "${PR_BODY}")"
PR_URL="$(printf '%s' "${PR_RESP}" | jq -r '.html_url // empty')"
if [ -n "${PR_URL}" ]; then
  # Sentinel parsed by the worker -> stored on the run + work item.
  echo "::pr::${PR_URL}"
else
  log "PR not created: $(printf '%s' "${PR_RESP}" | jq -r '.message // "unknown error"')"
fi

log "DONE"
