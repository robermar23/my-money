#!/bin/sh
# Start the web app inside the container (PLAN19 P19-21, ADR-054 §4).
#
# docker/compose.yaml runs this as the `app` command. With MONEY_AUTO_MIGRATE
# unset or anything but exactly "true" (the default), it is `exec node
# server.js` and nothing else — the same process the image's own CMD starts.
#
# With MONEY_AUTO_MIGRATE=true it first applies any pending migrations. That is
# OFF by default, and the risk is stated wherever the flag is documented
# (.env.example, docs/DEPLOY.md §Updates):
#   - it changes the schema of a financial database unattended, on every start,
#     and takes NO backup first;
#   - drizzle applies all pending migrations in one transaction, so a failure
#     rolls back cleanly — but the app then exits, `restart: unless-stopped`
#     brings it back, it fails again, and the app stays down until you step in.
# The recommended path is the explicit one: back up, then
# `scripts/prod.sh migrate`, then restart.
#
# Only the app ever migrates. The worker never runs this script, so two
# containers can never race to apply the same migration.
set -eu

if [ "${MONEY_AUTO_MIGRATE:-}" = "true" ]; then
  echo "[app-start] MONEY_AUTO_MIGRATE=true: applying pending migrations (no backup is taken)" >&2
  node_modules/.bin/drizzle-kit migrate
fi

exec node server.js
