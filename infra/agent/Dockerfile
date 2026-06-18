# Agent runtime image: a *persistent* container, one per agent. Created once and
# kept across runs (started on dispatch, stopped when idle) so installed tooling
# and the cached repo clone survive. A run is a `docker exec` of run-task.sh.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (used for real runs; dry-run mode doesn't need it)
RUN npm install -g @anthropic-ai/claude-code || true

WORKDIR /work
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY run-task.sh /usr/local/bin/run-task.sh
COPY reflect-task.sh /usr/local/bin/reflect-task.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/run-task.sh /usr/local/bin/reflect-task.sh

# Idle daemon keeps the container alive between runs.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
