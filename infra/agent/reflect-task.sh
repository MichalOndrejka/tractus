#!/usr/bin/env bash
# Reflection pass: run once (via `docker exec`) after a task so a *learning*
# agent can improve its own instructions. Inputs come from env (see worker.ts):
#   REFLECT_PROMPT   -> the full reflection prompt (instructions + transcript + outcome)
#   MODEL_ID, PROVIDER, ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
#   CONDUIT_MCP_URL / CONDUIT_API_KEY -> optional shared memory (so it can `remember`)
#
# It prints the model's response to stdout (captured by the backend), which is
# expected to contain a `::summary::` line and an
# `::instructions-begin:: … ::instructions-end::` block.
set -uo pipefail

cleanup() { rm -f /work/.reflect.mcp.json; }
trap cleanup EXIT

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[reflect] no Claude Code credentials — skipping"
  exit 0
fi

args=(-p --permission-mode acceptEdits)
[ -n "${MODEL_ID:-}" ] && args+=(--model "${MODEL_ID}")
if [ -n "${CONDUIT_MCP_URL:-}" ]; then
  cat > /work/.reflect.mcp.json <<EOF
{ "mcpServers": { "conduit": { "type": "http", "url": "${CONDUIT_MCP_URL}",
  "headers": { "Authorization": "Bearer ${CONDUIT_API_KEY:-}" } } } }
EOF
  args+=(--mcp-config /work/.reflect.mcp.json --allowedTools "mcp__conduit")
fi

printf '%s' "${REFLECT_PROMPT:-}" | claude "${args[@]}"
