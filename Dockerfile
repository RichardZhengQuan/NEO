# ─── Stage 1: build ───────────────────────────────────────────────────────────
# Installs all deps, builds every package, then prunes to production deps.
FROM node:22-slim AS builder

# Install corepack and pin pnpm version.
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

WORKDIR /app

# ── Copy manifests first so the layer is cached when only source changes. ──
# pnpm needs the workspace file and every package.json before installing.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/protocol/package.json  packages/protocol/
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

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
# Slim image: only Node, the built dist files and production node_modules.
FROM node:22-slim AS runtime

# Re-enable corepack so `pnpm` is available for potential future use.
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

# Create a non-root user.
RUN groupadd --system neo && useradd --system --gid neo --home /app neo

WORKDIR /app

# ── Copy built artefacts from the builder stage ──
COPY --from=builder --chown=neo:neo /app/node_modules               ./node_modules
COPY --from=builder --chown=neo:neo /app/package.json               ./
COPY --from=builder --chown=neo:neo /app/pnpm-workspace.yaml        ./
COPY --from=builder --chown=neo:neo /app/packages/protocol/dist     ./packages/protocol/dist
COPY --from=builder --chown=neo:neo /app/packages/protocol/package.json ./packages/protocol/
COPY --from=builder --chown=neo:neo /app/packages/storage/dist      ./packages/storage/dist
COPY --from=builder --chown=neo:neo /app/packages/storage/package.json  ./packages/storage/
COPY --from=builder --chown=neo:neo /app/packages/providers/dist    ./packages/providers/dist
COPY --from=builder --chown=neo:neo /app/packages/providers/package.json ./packages/providers/
COPY --from=builder --chown=neo:neo /app/packages/memory/dist       ./packages/memory/dist
COPY --from=builder --chown=neo:neo /app/packages/memory/package.json   ./packages/memory/
COPY --from=builder --chown=neo:neo /app/packages/tools/dist        ./packages/tools/dist
COPY --from=builder --chown=neo:neo /app/packages/tools/package.json    ./packages/tools/
COPY --from=builder --chown=neo:neo /app/packages/core/dist         ./packages/core/dist
COPY --from=builder --chown=neo:neo /app/packages/core/package.json     ./packages/core/
COPY --from=builder --chown=neo:neo /app/packages/server/dist       ./packages/server/dist
COPY --from=builder --chown=neo:neo /app/packages/server/package.json   ./packages/server/
COPY --from=builder --chown=neo:neo /app/packages/client/dist       ./packages/client/dist
COPY --from=builder --chown=neo:neo /app/packages/client/package.json   ./packages/client/
COPY --from=builder --chown=neo:neo /app/packages/ui/dist           ./packages/ui/dist
COPY --from=builder --chown=neo:neo /app/packages/ui/package.json       ./packages/ui/
COPY --from=builder --chown=neo:neo /app/packages/cli/dist          ./packages/cli/dist
COPY --from=builder --chown=neo:neo /app/packages/cli/package.json      ./packages/cli/
COPY --from=builder --chown=neo:neo /app/apps/web/dist              ./apps/web/dist
COPY --from=builder --chown=neo:neo /app/apps/web/package.json          ./apps/web/

# Persistent data volume (neo.db, key, token, vapid.json, plugins/).
VOLUME /data

# Runtime configuration via environment variables (see docs/DEPLOYMENT.md).
ENV NEO_MODE=server \
    NEO_HOST=0.0.0.0 \
    NEO_PORT=7777 \
    NEO_DATA_DIR=/data \
    NEO_WEB_DIR=/app/apps/web/dist \
    NODE_ENV=production

EXPOSE 7777

# Liveness check on the health endpoint.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:7777/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

USER neo

CMD ["node", "packages/cli/dist/index.js", "serve"]
