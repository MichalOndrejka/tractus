#!/usr/bin/env bash
# Idle daemon (PID 1) for a *persistent* agent container.
#
# The container is created once per agent and kept across runs so installed
# tooling and the cached repo clone survive (see infra/agent/run-task.sh, which
# the backend invokes via `docker exec`). This entrypoint just keeps the
# container alive while it sits idle; the backend stops it to save resources and
# starts it again on the next dispatch.
set -uo pipefail
mkdir -p /work/repos
echo "[agent] container ready — waiting for tasks"
exec sleep infinity
