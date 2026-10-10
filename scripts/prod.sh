#!/bin/sh
# Operator commands for the production stack (PLAN19 P19-22, ADR-054 §7).
#
# Run it on the server, from anywhere:
#   sh /path/to/my-money/scripts/prod.sh <command>
#
# Commands:
#   pull                 Fetch the image MONEY_IMAGE_REPO:MONEY_IMAGE_TAG names
#   backup               Take an encrypted backup now, then list /backups
#   migrate              Apply pending database migrations
#   restart              Recreate app + worker (picks up a new image or .env)
#   job <name>           Run one worker job once (e.g. backfill-categories)
#   ps | logs            Container status | follow app + worker logs
#
# The upgrade, in order (docs/DEPLOY.md §Updates):
#   pull → read the CHANGELOG's Migrations line → backup → migrate → restart
#
# Settings, all optional:
#   MONEY_REPO_DIR          The checkout holding docker/compose.yaml.
#                           Default: the directory above this script.
#   MONEY_ENV_FILE          Default: $MONEY_REPO_DIR/.env, or .env.local when
#                           there is no .env (the dev-box convention).
#   MONEY_COMPOSE_OVERRIDE  A second compose file, e.g. the Unraid bind-mount
#                           override (DEPLOY.md §U.3). Leave it unset unless
#                           your stack was created with that file: adding or
#                           removing it on an existing stack changes where
#                           Postgres keeps its data, and compose will offer to
#                           recreate the volume. Answer N.
#
# Two things this script does for you that are easy to get wrong by hand:
#   - One-off jobs use `run --rm`, never `exec`. `exec` reuses the RUNNING
#     worker, whose environment was frozen when the container was created, so a
#     BACKUP_AGE_RECIPIENT added to .env afterwards is invisible to it and the
#     backup logs `disabled … skipping`. `run --rm` re-reads the env file.
#   - Jobs load ./scripts/loaders/register.mjs, which stubs Next's
#     `server-only` marker. Without it run-once.ts fails with
#     `ERR_MODULE_NOT_FOUND: Cannot find package 'server-only'`.
set -eu

MONEY_REPO_DIR="${MONEY_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -z "${MONEY_ENV_FILE:-}" ]; then
  if [ -f "$MONEY_REPO_DIR/.env" ]; then
    MONEY_ENV_FILE="$MONEY_REPO_DIR/.env"
  else
    MONEY_ENV_FILE="$MONEY_REPO_DIR/.env.local"
  fi
fi

if [ ! -f "$MONEY_REPO_DIR/docker/compose.yaml" ]; then
  echo "prod.sh: no docker/compose.yaml under $MONEY_REPO_DIR (set MONEY_REPO_DIR)" >&2
  exit 2
fi
if [ ! -f "$MONEY_ENV_FILE" ]; then
  echo "prod.sh: env file $MONEY_ENV_FILE not found (set MONEY_ENV_FILE)" >&2
  exit 2
fi

# The project name is fixed by `name: my-money` in compose.yaml, so the volume
# names (my-money_postgres_data, …) are the same however this is invoked.
dc() {
  if [ -n "${MONEY_COMPOSE_OVERRIDE:-}" ]; then
    docker compose --project-directory "$MONEY_REPO_DIR" \
      -f "$MONEY_REPO_DIR/docker/compose.yaml" -f "$MONEY_COMPOSE_OVERRIDE" \
      --env-file "$MONEY_ENV_FILE" --profile prod "$@"
  else
    docker compose --project-directory "$MONEY_REPO_DIR" \
      -f "$MONEY_REPO_DIR/docker/compose.yaml" \
      --env-file "$MONEY_ENV_FILE" --profile prod "$@"
  fi
}

# One worker job, once, in a fresh container (see the `run --rm` note above).
run_job() {
  dc run --rm --no-deps worker \
    node --experimental-strip-types --import tsx --import ./scripts/loaders/register.mjs \
    src/worker/run-once.ts "$1"
}

usage() {
  # The header comment, up to the notes that follow the settings.
  sed -n '2,/^# Two things/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

cmd="${1:-help}"
[ "$#" -gt 0 ] && shift

case "$cmd" in
  pull)
    dc pull
    ;;
  backup)
    # Refuse rather than "succeed": with no recipient the job skips and exits
    # 0, and an upgrade ritual must not mistake that for a backup.
    dc run --rm --no-deps worker sh -c '
      if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
        echo "prod.sh: BACKUP_AGE_RECIPIENT is not set, so no backup can be taken." >&2
        echo "Configure it (docs/BACKUP.md), or take a manual dump (docs/DEPLOY.md §Updates)." >&2
        exit 3
      fi'
    run_job backup-database-daily
    dc run --rm --no-deps worker ls -lh /backups
    ;;
  migrate)
    dc run --rm app node_modules/.bin/drizzle-kit migrate
    ;;
  restart)
    dc up -d --force-recreate app worker
    ;;
  job)
    if [ "$#" -ne 1 ]; then
      echo "usage: prod.sh job <name>   (names: src/worker/run-once.ts)" >&2
      exit 2
    fi
    run_job "$1"
    ;;
  ps)
    dc ps
    ;;
  logs)
    dc logs -f app worker
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    echo "prod.sh: unknown command '$cmd'" >&2
    usage >&2
    exit 2
    ;;
esac
