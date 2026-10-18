# Contributing to my-money

my-money is a **single-user, self-hosted** personal finance tracker that one
person built for one household. Contributions are welcome when they keep it that
way. Read this whole page before opening a pull request; the guardrails at the
end are not negotiable.

> **Security problems do not go here.** Report them privately as described in
> [SECURITY.md](SECURITY.md), and never paste a `.env`, a dump, a token or a
> transaction row into an issue or a pull request.

## Prerequisites

- **Node.js 22 or later** (the scripts rely on `--env-file`, `process.loadEnvFile`
  and `--import tsx`).
- **pnpm 11** (`corepack enable` picks up the version pinned in `package.json`).
- **Docker** with the `compose` plugin, for Postgres and Redis.
- **Git.**

## The test suite needs its own database (read this first)

The Vitest suite **truncates shared tables**. To make sure it can never wipe
real data, it runs only against a dedicated test Postgres, and
[vitest.setup.ts](vitest.setup.ts) **refuses to start** otherwise:

```ts
if (!dbName.includes("test")) {
  throw new Error(
    `TEST_DATABASE_URL points at database "${dbName}", which does not look like a test database. The name must contain "test" (e.g. money_test) so destructive TRUNCATEs cannot hit dev data by mistake.`,
  );
}
```

It throws a similar error if `TEST_DATABASE_URL` is not set at all.
**This refusal is deliberate.** If you see it, the suite is not broken; it is
protecting a database it was not pointed at. To satisfy it:

```sh
cp .env.example .env.local     # TEST_DATABASE_URL is already filled in
make up                        # dev Postgres :5433, test Postgres :5434, Redis :6380
```

`make up` starts a **second** Postgres on `127.0.0.1:5434` with a database named
`money_test`. It sits behind the compose `dev` profile, which `make up` passes, so a
production deploy (`--profile prod`) never starts it; a bare
`docker compose up` without `--profile dev` will not start it either. The suite applies every migration to it before any test runs, so
you never migrate it by hand.

## Getting set up

```sh
pnpm install
cp .env.example .env.local     # then generate SESSION_SECRET and MONEY_ENCRYPTION_KEY
make up
pnpm db:migrate                # the dev database, not the test one
pnpm dev                       # http://127.0.0.1:4000
pnpm worker                    # in a second terminal
```

Generate each secret with `openssl rand -base64 32`. The first visit to
`/login` sets the password. Forgotten it? `make db-reset-password` deletes only
the `users` row; your data stays.

The dev stack uses **port 4000** for the app, **5433** for Postgres, **5434**
for the test Postgres and **6380** for Redis, to stay clear of anything already
on the host.

`make seed-demo` fills an empty dev database with a fictional household.
`make db-reset` empties it again; to start completely fresh, drop the volumes:

```sh
docker compose -f docker/compose.yaml --profile dev down -v
make up && pnpm db:migrate
```

`make help` lists every other target.

## The gate: `pnpm check` and `pnpm test`

A pull request must pass both:

```sh
pnpm check   # Biome lint + format check, then tsc --noEmit (strict)
pnpm test    # Vitest, against the test database above
```

- **Biome is the only linter and formatter.** There is no ESLint and no
  Prettier, and a pull request should not add either. `pnpm format` applies
  Biome's fixes.
- **Line endings are LF** everywhere ([.gitattributes](.gitattributes)).
- Write tests where they earn their keep: money helpers, importers and their
  deduplication, Plaid webhook verification, snapshot computation, and the pure
  rules engines. Do not add a test just to have one, and do not test the
  framework or Drizzle itself.
- **A new page needs a help entry; CI will tell you.** Every page except
  `/login` explains itself behind `?`, and a page without an entry fails
  `pnpm test`. [docs/HELP.md](docs/HELP.md) says how to write one.
- Playwright (`pnpm test:e2e`) covers a handful of critical flows. Run it when
  you touch one of them, and **not against a database you want to keep**: it
  empties the users, accounts and transactions of whatever `DATABASE_URL`
  names, which by default is your dev database. Point it at a scratch one (a
  variable already set wins over `.env.local`):

  ```sh
  docker compose -f docker/compose.yaml exec -T postgres psql -U money -d money -c "CREATE DATABASE money_e2e;"
  export DATABASE_URL=postgres://money:<password>@127.0.0.1:5433/money_e2e
  export REDIS_URL=redis://127.0.0.1:6380/7
  pnpm db:migrate && pnpm test:e2e
  ```

CI runs the same gate on every push and pull request
([.github/workflows/ci.yml](.github/workflows/ci.yml)): `pnpm check`, then
`pnpm test` against a throwaway Postgres 16 named `money_test`, then
`pnpm build`. It uses no `.env.local` and no stored secret (the encryption key
the Plaid tests need is generated for each run), so a green run on your fork
means the same thing it means here. Playwright runs separately, by hand,
from [.github/workflows/e2e.yml](.github/workflows/e2e.yml).

## Project layout

```text
src/app/          Next.js App Router: pages, route handlers, server actions
src/components/   Shared React components
src/db/schema/    Drizzle tables, one file per domain concept
src/lib/          Domain logic, one directory per concept (money/ is the
                  decimal wrapper all arithmetic goes through)
src/worker/       BullMQ worker: a separate process, same codebase
drizzle/          Generated migrations
e2e/              Playwright specs
docker/           compose.yaml, and the optional Unraid override
scripts/          prod.sh (operator commands), app-start.sh, maintenance
docs/             Operator and feature documentation
plans/features/   Design records: FEATURE.md, IDEAS.md (ADRs), PLAN*.md
```

## Where design decisions live

Every non-trivial decision is written down before it is built:

- [plans/features/FEATURE.md](plans/features/FEATURE.md): what is in scope,
  and what is deliberately out.
- [plans/features/IDEAS.md](plans/features/IDEAS.md) §11, the **Decision Log**:
  numbered ADRs. Accepted ADRs are never edited; a new decision gets a new row.
- `plans/features/PLAN*.md`: the per-phase task breakdowns that implement them.

**A non-trivial change comes with an ADR.** That means a new table, a new outbound
request, a new dependency, a new job or a change to how a figure is computed.
Open an issue first, and propose the ADR there or in the pull request. If the
change is not in scope according to FEATURE.md, expect the answer to be "no",
and expect it to cite the line that says so.

## Guardrails (non-negotiable)

These come from [CLAUDE.md](CLAUDE.md), which is the full list and governs every
change. A pull request that breaks one of them will not be merged, however good
it is otherwise.

- **Money is a string, end to end.** Money columns are `NUMERIC`, Drizzle
  returns them as strings, and all arithmetic goes through the `Money` helper in
  [src/lib/money/](src/lib/money/). Never use native `+ - * /` on money, and never
  round-trip through `Number` except to format for display.
- **Zero third-party egress.** No analytics, no telemetry, no crash reporting,
  no update-check ping, no SaaS observability, no marketing pixels. The only
  outbound calls are Plaid, public market-data endpoints, and the operator's own
  SMTP server. A new outbound request needs an ADR and a privacy-egress test.
- **No LLM over financial data.** Financial data is never sent to a hosted AI
  API. Anything model-shaped must run locally, and it needs an ADR first.
- **Single user.** There is one password and one `users` row. No accounts,
  signup, roles, invitations, sharing or external identity providers. A second
  household runs its own instance.
- **Read-only.** No bill pay, money movement or ACH. No double-entry ledger,
  no tax forms. This is not Quicken.
- **Plaid tokens are encrypted at rest**, Plaid secrets never reach the browser,
  and webhooks are signature-verified and idempotent.
- **Never drop a column without a backup step.** Historical financial data is
  the whole product.
- **Never commit real financial data.** No real statement, export, screenshot,
  account number or payee line, not even in a test. Fixtures are synthetic by
  construction and live in `src/lib/importers/*/__fixtures__/`; a test that needs
  a real-world shape gets an invented value with the same shape. A screenshot
  for the docs comes from the demo household (`make seed-demo`), never from a
  real instance. [no-pii.test.ts](src/lib/instance/no-pii.test.ts) fails the
  build on a statement file or image outside the fixtures and on an
  account-number-shaped digit run; it also checks an optional private denylist
  (`.pii-denylist`, git-ignored, or `MONEY_PII_DENYLIST`), which is never
  committed because a published list would publish its contents.

## Every autumn: next year's contribution limits

The guidance engine's IRS contribution limits are checked in, one row per year,
in `STATUTORY_LIMITS` in
[src/lib/advice/constants.ts](src/lib/advice/constants.ts). The IRS publishes
the following year's 401(k), IRA and HSA figures each autumn; add the new row
then, with its source. **Never carry a year forward**: a missing year makes the
affected rung say so, while a copied year gives confident wrong dollars.
Settings → Instance warns while this year or next is missing (ADR-034 §5,
ADR-053 §2; [docs/GUIDANCE.md](docs/GUIDANCE.md#what-happens-every-january)).

## Cutting a release

A release is a version, a tag that matches it, and a CHANGELOG entry that says
which migration it needs (ADR-054). In order:

1. In [CHANGELOG.md](CHANGELOG.md), replace `Unreleased` on the top entry with
   the date. Its `Migrations:` line must name the newest file in `drizzle/`;
   a test fails the build if it does not, and if the top entry's version and
   `package.json`'s disagree.
2. Merge to `master`, then tag the merge commit and push the tag:
   `git tag -a v0.19.0 -m "my-money 0.19.0"`.
3. From that commit, `make image-release`. It refuses to run anywhere except
   on the commit tagged `v<package.json version>`, and pushes the image as
   `:<version>`, `:<git sha>` and `:latest`.
4. Start the next one: bump `version` in `package.json` and open a new
   `## [x.y.z] - Unreleased` entry at the top of the changelog.

## License

my-money is licensed **AGPL-3.0-or-later** ([LICENSE](LICENSE)). By submitting
a contribution you agree that it is licensed under the same terms.
