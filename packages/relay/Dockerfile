# Build context: repository root (docker build -f packages/relay/Dockerfile .).
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/tunnel/package.json packages/tunnel/
COPY packages/relay/package.json packages/relay/

RUN pnpm install --frozen-lockfile \
      --filter @neo/protocol \
      --filter @neo/tunnel \
      --filter @neo/relay

COPY tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/tunnel/ packages/tunnel/
COPY packages/relay/ packages/relay/

RUN pnpm --filter @neo/protocol build \
 && pnpm --filter @neo/tunnel build \
 && pnpm --filter @neo/relay build

RUN pnpm --filter @neo/relay deploy --prod --legacy /prod

FROM node:22-slim AS runtime

RUN groupadd --system neo && useradd --system --gid neo --home /app neo
WORKDIR /app
COPY --from=builder --chown=neo:neo /prod ./

ENV RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8787 \
    NODE_ENV=production
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||'8787')+'/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

USER neo
CMD ["node", "dist/main.js"]
