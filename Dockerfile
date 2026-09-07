# Lead Bot Cloud — Node server + Claude Code CLI in one image.
FROM node:22-bookworm-slim

# git and ca-certificates are what the Claude Code CLI expects to find; curl is
# for the healthcheck. Nothing else is needed — the server has no npm deps.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@latest \
  && npm cache clean --force

# Claude Code refuses to bypass permissions as root, so the app runs as its own user.
RUN useradd -m -u 1001 leadbot && mkdir -p /app /data && chown -R leadbot:leadbot /app /data
WORKDIR /app
COPY --chown=leadbot:leadbot server.mjs ui.html login.html segments.default.json package.json ./
COPY --chown=leadbot:leadbot skill ./skill
USER leadbot

# Persistent storage (users, history, runs, zoho.json) lives on a volume mounted here.
ENV DATA_DIR=/data \
    PORT=8080 \
    NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    HOME=/home/leadbot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fs http://localhost:8080/healthz || exit 1
CMD ["node", "server.mjs"]
