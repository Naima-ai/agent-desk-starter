# Agent Desk — production image. Build context: this folder.
#   docker build -t agent-desk:latest .
# Configuration is environment-only (see docker-compose.yml at the repo root);
# nothing secret is baked into the image.

# ---- 1. production dependencies (cached until package*.json changes) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 2. runtime: only what is needed to run, as a non-root user ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend
COPY contracts ./contracts
COPY frontend ./frontend
# data/ = evidence, knowledge, roster, audit, email log (mount a volume here)
# build/ = compiled seat skill files, regenerated on demand
RUN mkdir -p /app/data /app/build && chown -R node:node /app/data /app/build
USER node
EXPOSE 5173
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node is PID 1 and handles SIGTERM itself (graceful shutdown in server.mjs); compose also sets init: true
CMD ["node", "backend/server.mjs"]
