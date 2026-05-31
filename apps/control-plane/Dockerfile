# =============================================================================
# @imsg/control-plane — Bun image.
#
# Built from the MONOREPO ROOT (build context = repo root) so the Bun workspace
# resolves @imsg/shared + @imsg/transport. Build with:
#   docker build -f apps/control-plane/Dockerfile -t imsg-control-plane .
# =============================================================================
FROM oven/bun:1.3.11-slim AS base
WORKDIR /app

# --- deps: install the full workspace so workspace:* links resolve -----------
FROM base AS deps
# Root manifests + lockfile first (better layer caching).
COPY package.json bun.lock* ./
# Workspace package manifests (so Bun knows the graph before sources).
COPY packages/shared/package.json   packages/shared/package.json
COPY packages/transport/package.json packages/transport/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
# Install all workspace deps (no scripts).
RUN bun install --frozen-lockfile || bun install

# --- runtime image -----------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Bring in installed node_modules from deps.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
# Source for the three packages the control plane needs (Bun runs TS directly).
COPY packages/shared    packages/shared
COPY packages/transport packages/transport
COPY apps/control-plane  apps/control-plane

EXPOSE 8080
ENV PORT=8080

# Run the TypeScript entrypoint directly (Bun transpiles on import).
CMD ["bun", "run", "apps/control-plane/src/index.ts"]
