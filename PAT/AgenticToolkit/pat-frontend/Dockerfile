# syntax=docker/dockerfile:1.7

# ──────────────────────── 1. Build stage ─────────────────────────────
# Compile the React SPA with Vite. We use bun for fast cold installs.
FROM oven/bun:1.1 AS build
WORKDIR /app

# Cache deps independently from source.
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# No build-args: the (public) Clerk key is injected at RUNTIME by the Hono server
# as window.__PUBLIC_ENV__ from PUBLIC_CLERK_PUBLISHABLE_KEY (see server/public-env.ts).
# A plain deploy can no longer ship a keyless client.

# Copy the rest and build.
COPY . .
RUN bun run build

# ──────────────────────── 2. Runtime stage ───────────────────────────
# Bun image running the Hono server. The client deps are bundled into dist/ by
# Vite; the SERVER still needs its runtime deps (hono, @clerk/hono, @clerk/
# backend, …), so we ship the full node_modules. (better-sqlite3 is only the
# Node/vitest fallback — never loaded under bun, which uses bun:sqlite.)
FROM oven/bun:1.1-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

EXPOSE 8787

CMD ["bun", "run", "server/index.ts"]
