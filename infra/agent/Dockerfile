# Agent runtime image: an isolated container in which a single agent run executes.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (used for real runs; dry-run mode doesn't need it)
RUN npm install -g @anthropic-ai/claude-code || true

WORKDIR /work
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
