# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for my-money. Produces one image with two entrypoints:
#   - web (default): runs the Next.js standalone server
#   - worker: runs the BullMQ background worker
#
# Both share the same source tree so domain logic isn't duplicated. The compose
# file selects which entrypoint via the `command` directive per service.

# ── deps stage: install pnpm + production deps ──────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Enable corepack to use the pnpm version pinned in package.json.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ── build stage: compile Next.js (standalone output) ────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json next.config.ts ./
COPY postcss.config.mjs biome.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build

# ── runtime stage: minimal image with both entrypoints available ────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# Web entrypoint: Next.js standalone bundle (compact — only what the app needs).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Worker entrypoint: copy source + node_modules so we can run tsx on src/worker.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json /app/tsconfig.json ./

EXPOSE 4000

# Default to the web server. Compose overrides for the worker service.
CMD ["node", "server.js"]
