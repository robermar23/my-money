# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for my-money. Produces one image with two entrypoints:
#   - web (default): runs the Next.js standalone server
#   - worker: runs the BullMQ background worker
#
# Both share the same source tree so domain logic isn't duplicated. The compose
# file selects which entrypoint via the `command` directive per service.
#
# Multi-arch (P6-21): builds clean for both linux/amd64 and linux/arm64 (the Pi
# target, IDEAS.md §1). Every native dependency has a glibc arm64 prebuild —
# @node-rs/argon2 (*-linux-arm64-gnu), Next's SWC (@next/swc-linux-arm64-gnu),
# Tailwind v4's lightningcss — and the runtime-stage system binaries resolve on
# arm64 too: the PGDG apt repo publishes arm64 postgresql-client-16 and `age` is
# in bookworm main. The bookworm-slim base (glibc, not musl) is what makes the
# -gnu prebuilds the right ones; do NOT switch to alpine without re-checking each
# native dep's musl prebuild. Cross-build with:
#   docker buildx build --platform linux/amd64,linux/arm64 -t my-money:latest .

# ── deps stage: install pnpm + production deps ──────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Disable libuv's io_uring backend. Node 22's bundled libuv turns io_uring on by
# default, but QEMU (used to emulate linux/arm64 on an amd64 build host) emulates
# those syscalls incorrectly — Node finishes its work and then aborts on event-
# loop teardown with `uv__io_poll: Assertion errno == EEXIST failed`, killing
# `pnpm install` / `next build` with SIGABRT (exit 134). Skipping io_uring avoids
# the emulation bug; on real arm64/amd64 hardware the cost is negligible for a
# single-user app. Set in every Node-running stage below.
ENV UV_USE_IO_URING=0

# Enable corepack to use the pnpm version pinned in package.json.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ── build stage: compile Next.js (standalone output) ────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
# See deps stage: avoid the QEMU io_uring abort during `next build`.
ENV UV_USE_IO_URING=0
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json next.config.ts ./
COPY postcss.config.mjs biome.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
# Static assets served from /public. Kept even when empty (a `.gitkeep` holds the
# dir) so the runtime stage's `COPY --from=build /app/public` always resolves and
# the Next standalone server has its public root.
COPY public ./public

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build

# ── runtime stage: minimal image with both entrypoints available ────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# Backup tooling (P6-03, ADR-014): pg_dump + age for the nightly backup job.
# This base is Debian bookworm (apt, not apk). Its stock `postgresql-client` is
# v15, which refuses to dump a v16 server — so we add the official PGDG apt repo
# to get the matching v16 client. `age` ships in bookworm main. curl/gnupg are
# only needed to fetch the repo key, so we purge them afterward to stay lean.
# (Single shared runtime stage → both the web and worker entrypoints carry these
# binaries; only the worker's backup job uses them.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg age \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

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
