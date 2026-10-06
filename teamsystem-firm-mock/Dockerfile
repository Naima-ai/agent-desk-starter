# TeamSystem Firm mock — image for demos and integration tests. Build context: this folder.
#   docker build -t teamsystem-mock:latest .
# Debian (glibc) rather than Alpine on purpose: pdf-parse pulls a native canvas binary.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5680 \
    TS_STATE_DIR=/state
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
# /state = custom clients, edit history, workflow state, uploaded attachments (mount a volume here)
RUN mkdir -p /state/attachments && chown -R node:node /state
USER node
EXPOSE 5680
VOLUME ["/state"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/server.mjs"]
