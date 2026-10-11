# ─── Stage 1: build ───────────────────────────────────────────────────────────
# Installs build dependencies, then creates a production deployment bundle.
FROM node:22-slim AS builder

# Install corepack and pin pnpm version.
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

WORKDIR /app

# ── Copy manifests first so the layer is cached when only source changes. ──
# pnpm needs the workspace file and every package.json before installing.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/protocol/package.json  packages/protocol/
COPY packages/tunnel/package.json    packages/tunnel/
COPY packages/storage/package.json   packages/storage/
COPY packages/providers/package.json packages/providers/
COPY packages/memory/package.json    packages/memory/
COPY packages/tools/package.json     packages/tools/
COPY packages/core/package.json      packages/core/
COPY packages/server/package.json    packages/server/
COPY packages/client/package.json    packages/client/
COPY packages/ui/package.json        packages/ui/
COPY packages/cli/package.json       packages/cli/
COPY apps/web/package.json           apps/web/

# Skip the desktop and mobile packages — they pull in Electron / Capacitor and
# are not needed in the server image.  Also skip the Electron binary download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install all dependencies (the --filter approach below is used for the final
# prune; the full install is needed so the build can reference sibling sources).
RUN pnpm install --frozen-lockfile \
      --filter @neo/protocol \
      --filter @neo/tunnel \
      --filter @neo/storage \
      --filter @neo/providers \
      --filter @neo/memory \
      --filter @neo/tools \
      --filter @neo/core \
      --filter @neo/server \
      --filter @neo/client \
      --filter @neo/ui \
      --filter @neo/web \
      --filter @neo/cli

# ── Copy all sources ──
COPY packages/ packages/
COPY apps/web/  apps/web/
COPY tsconfig.base.json vitest.shared.ts ./

# ── Build (topological order is handled by pnpm -r) ──
RUN pnpm -r --filter @neo/protocol build \
 && pnpm -r --filter @neo/tunnel    build \
 && pnpm -r --filter @neo/storage   build \
 && pnpm -r --filter @neo/providers build \
 && pnpm -r --filter @neo/memory    build \
 && pnpm -r --filter @neo/tools     build \
 && pnpm -r --filter @neo/core      build \
 && pnpm -r --filter @neo/server    build \
 && pnpm -r --filter @neo/client    build \
 && pnpm -r --filter @neo/ui        build \
 && pnpm -r --filter @neo/web       build \
 && pnpm -r --filter @neo/cli       build

# ── Create a self-contained production deployment for the CLI ──
# pnpm deploy bundles the CLI and all its transitive workspace + external
# dependencies into /prod, so the runtime stage needs no pnpm or source workspace.
# Dependency links stay inside the deployed bundle. --legacy because
# pnpm >=10 only deploys injected workspaces by default.
RUN pnpm --filter @neo/cli deploy --prod --legacy /prod

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
# Slim image: Node + the pnpm-deployed CLI bundle + the web static build.
FROM node:22-slim AS runtime

# Create a non-root user.
RUN groupadd --system neo && useradd --system --gid neo --home /app neo \
 && mkdir -p /data && chown neo:neo /data

WORKDIR /app

# ── Copy the self-contained CLI bundle ──
# /prod contains dist/, node_modules/ (including its dependency links) and package.json.
COPY --from=builder --chown=neo:neo /prod ./

# ── Copy the web app static build (served via NEO_WEB_DIR) ──
COPY --from=builder --chown=neo:neo /app/apps/web/dist ./apps/web/dist

# Persistent data volume (neo.db, key, token, tunnel-identity.json, vapid.json, plugins/).
VOLUME /data

# Runtime configuration via environment variables (see docs/DEPLOYMENT.md).
ENV NEO_MODE=server \
    NEO_HOST=0.0.0.0 \
    NEO_PORT=7777 \
    NEO_DATA_DIR=/data \
    NEO_WEB_DIR=/app/apps/web/dist \
    NODE_ENV=production

EXPOSE 7777 7778

# Liveness check on the health endpoint.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:7777/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

USER neo

CMD ["node", "dist/index.js", "serve"]
