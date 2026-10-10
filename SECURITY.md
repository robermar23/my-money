# Security policy

my-money holds someone's whole financial life: balances, transactions, holdings,
and encrypted Plaid access tokens that can read their bank accounts. Please treat
any weakness you find as **private until it is fixed**.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security
problem.** Report it privately through the repository's **Security tab →
"Report a vulnerability"** (GitHub private vulnerability reporting). Only the
maintainer sees that report.

A useful report says:

- what an attacker can do, and from where (the internet through the tunnel, the
  LAN, a logged-in browser, or the host itself);
- the version or commit you tested;
- the steps to reproduce it, using **synthetic data only**.

This is a one-person project with no bug bounty and no service-level promise. A
real report still gets a reply, a fix, and a credit in the changelog if you want
one.

## Never paste these anywhere

Not into an issue, a pull request, a discussion, a gist, a pastebin, or a chat
with anyone (human or AI) while asking for help:

- a **`.env`** or `.env.local`, or any single line from one;
- a **`pg_dump`**, a backup file (`*.age`), or the backup private key;
- a **Plaid access token**, `client_id` or secret, or a Cloudflare tunnel token;
- `SESSION_SECRET`, `MONEY_ENCRYPTION_KEY`, or a session cookie;
- a **transaction row**, an account name, an account number, a balance, or a
  screenshot of a page that shows any of them.

If you need to show a bug, reproduce it on a fresh instance with made-up data.
If you already pasted a secret somewhere public, rotate it first (see below) and
then report it.

## The threat model in three sentences

my-money is **single-user and self-hosted**: one password protects one household's
data on hardware its owner controls, and there are no other accounts to attack
sideways. The app's only internet-facing surface is the Plaid webhook exposed
through a Cloudflare Tunnel (signature-verified, and rejected with `401`
otherwise), plus the web UI if the operator chooses to publish it. Its only
outbound traffic goes to Plaid, to public market-data endpoints, and to your
own SMTP server if you configure alert email, with **no
telemetry, analytics or third-party AI**, so the main risks are host compromise,
a leaked secret, and a weakness in that one public surface.

The full analyses are already written; this file does not repeat them:

- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): the whole app (auth, server
  actions, file import, secrets, headers, backups, alerts).
- [docs/THREAT_MODEL_PLAID.md](docs/THREAT_MODEL_PLAID.md): Plaid Link, the
  encrypted token store, the webhook, sync, and reauth.
- [docs/THREAT_MODEL_MARKETDATA.md](docs/THREAT_MODEL_MARKETDATA.md): the
  public market-data fetches.

## Rotating secrets

- **`MONEY_ENCRYPTION_KEY`**, the key that encrypts Plaid access tokens at rest:
  follow [docs/CRYPTO_ROTATION.md](docs/CRYPTO_ROTATION.md) exactly. Losing it
  makes every Plaid connection unreadable, so **back up first**.
- **`SESSION_SECRET`**: replace the value in `.env` with 32+ fresh random bytes
  and restart `app`. Every existing session is invalidated, which for a
  single-user app means you log in again. Nothing else is affected.
- **Plaid or Cloudflare credentials**: rotate them in the vendor's dashboard,
  update `.env`, and restart `app` and `worker`.

## Supported versions

Only the latest release, or `master` before the first tagged release, gets
security fixes. Pin a version with `MONEY_IMAGE_TAG` (see
[docs/DEPLOY.md](docs/DEPLOY.md)) and upgrade when a fix ships.
