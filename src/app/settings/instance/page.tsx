import { requireUser } from "@/lib/auth/require-user.ts";
import type { InstanceConfigState } from "@/lib/instance/config-state.ts";
import { type InstanceState, type Loaded, loadInstanceState } from "@/lib/instance/queries.ts";
import type { DrillStatus, MigrationStatus, WorkerLiveness } from "@/lib/instance/status.ts";
import {
  type ScheduleZone,
  effectiveZone,
  localTimeOfDay,
  utcOffsetLabel,
} from "@/lib/schedule/zone.ts";
import Link from "next/link";
import { recordRestoreDrillAction } from "./actions.ts";
import { PasswordForm } from "./password-form.tsx";

/**
 * `/settings/instance` — what this deployment is configured to do (PLAN19
 * P19-10, ADR-052 §5).
 *
 * Answers, on one screen, what a second operator otherwise needs a shell for:
 * which optional subsystems are on, whether the database matches this image,
 * whether the worker is alive, when the last backup ran and when a restore was
 * last practised, and which years of statutory limits are configured. It also
 * carries the change-password form (P19-33), the one other thing a second
 * operator needed a shell for.
 *
 * ── Safe to screenshot (ADR-052 §6) ────────────────────────────────────────
 * Configuration and time only. No balance, no account name, no transaction, no
 * secret — not even a masked one. A second operator will paste this page into a
 * public issue when asking for help, so it is built for that. P19-36 asserts it.
 *
 * ── A reporter, not a validator (ADR-052 §7) ───────────────────────────────
 * Every loader degrades to "unavailable" instead of throwing, so the page still
 * renders when the thing that is wrong is Redis or the database. An
 * unconfigured subsystem is shown with its consequence and the document that
 * fixes it — never as a bare "off", and never as an error.
 *
 * ── Distinct from `/api/health` ────────────────────────────────────────────
 * That probe is unauthenticated, static and cheap, for the container
 * healthcheck. This page is session-guarded, human-readable, and does more
 * work. Neither replaces the other.
 */

export const dynamic = "force-dynamic";

export default async function InstanceSettingsPage(): Promise<React.JSX.Element> {
  await requireUser();
  const state = await loadInstanceState();
  const workerConfig = "config" in state.worker ? state.worker.config : null;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-2 font-semibold text-2xl tracking-tight">Instance</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          How this installation is set up, read from its own configuration. Only the restore-drill
          date and the password can be changed here; the rest is set in your <code>.env</code> file.
        </p>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Every page the app has, and the question each one answers, is listed in{" "}
          <code>docs/FEATURES.md</code>.
        </p>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h2 className="font-medium">Safe to share</h2>
        <p className="mt-1 max-w-3xl text-zinc-600 dark:text-zinc-400">
          This page shows configuration and dates only: no balances, no account names, no
          transactions, and no passwords or keys, not even partly. You can screenshot it into a
          request for help.
        </p>
      </div>

      <ReleaseSection state={state} />
      <WorkerSection worker={state.worker} />
      <TimeSection zone={workerConfig?.timeZone ?? state.app.timeZone} now={state.now} />
      <BackupSection state={state} workerConfig={workerConfig} />
      <SubsystemSection app={state.app} worker={workerConfig} />
      <LimitsSection limits={state.limits} />
      <PasswordSection />
    </main>
  );
}

/* ── Building blocks ─────────────────────────────────────────────────────── */

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">{title}</h2>
      <dl className="mt-3 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">{children}</dl>
    </section>
  );
}

type Tone = "ok" | "warn" | "neutral";

const toneClass: Record<Tone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  neutral: "text-zinc-700 dark:text-zinc-300",
};

/** One labelled fact; `note` is the consequence and remedy when it matters. */
function Row({
  label,
  value,
  tone = "neutral",
  note,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly tone?: Tone;
  readonly note?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-3 sm:gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="sm:col-span-2">
        <span className={toneClass[tone]}>{value}</span>
        {note ? <div className="mt-0.5 text-xs text-zinc-500">{note}</div> : null}
      </dd>
    </div>
  );
}

/** Minute-precision UTC: unambiguous across time zones in a shared screenshot. */
function when(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const UNAVAILABLE_NOTE = "Could not be read just now. The server log has the reason.";

function isUnavailable<T>(value: Loaded<T>): value is { readonly kind: "unavailable" } {
  return (
    typeof value === "object" && value !== null && "kind" in value && value.kind === "unavailable"
  );
}

/* ── Sections ────────────────────────────────────────────────────────────── */

function ReleaseSection({ state }: { readonly state: InstanceState }): React.JSX.Element {
  return (
    <Section title="Release">
      <Row label="App version" value={state.version} />
      <Row
        label="Image"
        value={state.image ?? "Not reported"}
        note={
          state.image
            ? undefined
            : "MONEY_IMAGE_REPO and MONEY_IMAGE_TAG are not set for this process — normal outside the Docker Compose stack."
        }
      />
      <MigrationRow status={state.migrations} />
      <AutoMigrateRow on={state.app.autoMigrate} />
    </Section>
  );
}

const MIGRATE_NOTE = (
  <>
    Back up first, then run <code>scripts/prod.sh migrate</code> and restart. The steps are in{" "}
    <code>docs/DEPLOY.md</code> §Updates.
  </>
);

/** P19-21: on is a warning, because it trades the backup step for convenience. */
function AutoMigrateRow({ on }: { readonly on: boolean }): React.JSX.Element {
  return on ? (
    <Row
      label="Automatic migration"
      tone="warn"
      value="On (MONEY_AUTO_MIGRATE)"
      note="The app changes the database schema every time it starts, unattended, without taking a backup first. Recommended: turn it off and migrate by hand after a backup (docs/DEPLOY.md §Updates)."
    />
  ) : (
    <Row
      label="Automatic migration"
      value="Off"
      note="Migrations run only when you run them, which is the recommended setting."
    />
  );
}

function MigrationRow({ status }: { readonly status: Loaded<MigrationStatus> }): React.JSX.Element {
  if (isUnavailable(status)) {
    return <Row label="Database schema" value="Unknown" note={UNAVAILABLE_NOTE} />;
  }
  switch (status.kind) {
    case "current":
      return <Row label="Database schema" value={`Up to date (${status.latest})`} tone="ok" />;
    case "behind":
      return (
        <Row
          label="Database schema"
          tone="warn"
          value={`The database is at ${status.applied ?? "no migrations"}; this image expects ${status.latest}`}
          note={
            <>
              {status.pending.length} migration{status.pending.length === 1 ? "" : "s"} pending.{" "}
              {MIGRATE_NOTE}
            </>
          }
        />
      );
    case "ahead":
      return (
        <Row
          label="Database schema"
          tone="warn"
          value={`The database is newer than this image (which expects ${status.latest})`}
          note="An older image is running against a newer schema. Pull the release that matches the database."
        />
      );
    case "empty":
      return <Row label="Database schema" value="This image carries no migrations" tone="warn" />;
  }
}

function WorkerSection({
  worker,
}: {
  readonly worker: InstanceState["worker"];
}): React.JSX.Element {
  return (
    <Section title="Background worker">
      {isUnavailable(worker) ? (
        <Row label="Status" value="Unknown" note={UNAVAILABLE_NOTE} />
      ) : (
        <LivenessRow liveness={worker.liveness} />
      )}
    </Section>
  );
}

function LivenessRow({ liveness }: { readonly liveness: WorkerLiveness }): React.JSX.Element {
  const note =
    "The worker runs syncs, prices, snapshots, alerts and backups. Check it with `docker compose logs worker`.";
  switch (liveness.kind) {
    case "alive":
      return (
        <Row label="Status" value={`Running (last seen ${when(liveness.lastSeen)})`} tone="ok" />
      );
    case "stale":
      return (
        <Row
          label="Status"
          tone="warn"
          value={`Not seen since ${when(liveness.lastSeen)}`}
          note={note}
        />
      );
    case "never":
      return <Row label="Status" tone="warn" value="Has not reported yet" note={note} />;
  }
}

/**
 * P19-24/P19-25: when the nightly jobs run, and what a "day" is. The worker's
 * own `TZ` is shown when it has reported, because it is the worker that
 * schedules; the app's is the fallback (compose gives both the same value).
 */
function TimeSection({
  zone,
  now,
}: {
  readonly zone: ScheduleZone;
  readonly now: Date;
}): React.JSX.Element {
  const effective = effectiveZone(zone);
  // Today's UTC instants, so the local times shown carry today's daylight offset.
  const day = now.toISOString().slice(0, 10);
  const at = (hhmm: string): string => localTimeOfDay(effective, new Date(`${day}T${hhmm}:00Z`));
  const [dataFrom, dataTo, dayStarts] = [at("01:30"), at("05:00"), at("00:00")];
  return (
    <Section title="Time">
      <ZoneRow zone={zone} now={now} />
      <Row
        label="Nightly schedule"
        value={`Backup 04:00, Beancount export 04:30 (${effective})`}
        note={
          effective === "UTC"
            ? "Prices, snapshots, the Plaid sync and alerts run between 01:30 and 05:00 UTC, after the US market close."
            : `Prices, snapshots, the Plaid sync and alerts stay on UTC, 01:30 to 05:00, which is ${dataFrom} to ${dataTo} here. They are timed after the US market close, and moving them would change the prices they record.`
        }
      />
      <Row
        label="Day boundary"
        value={
          effective === "UTC"
            ? "Days are UTC dates"
            : `Days are UTC dates; a new day starts at ${dayStarts} here`
        }
        note="Nightly snapshots, the date a price is stored under, and the date forms fill in as today all follow UTC. Dates you type and dates your bank supplies are stored as given. Setting TZ does not change this (docs/DEPLOY.md §Time zone)."
      />
    </Section>
  );
}

function ZoneRow({
  zone,
  now,
}: {
  readonly zone: ScheduleZone;
  readonly now: Date;
}): React.JSX.Element {
  switch (zone.kind) {
    case "unset":
      return (
        <Row
          label="Time zone"
          value="UTC (TZ is not set)"
          note="Set MONEY_TZ in .env, for example America/New_York, to run the backup in your own night."
        />
      );
    case "zone":
      return (
        <Row label="Time zone" value={`${zone.zone} (${utcOffsetLabel(zone.zone, now)} now)`} />
      );
    case "invalid":
      return (
        <Row
          label="Time zone"
          tone="warn"
          value={`TZ=${zone.raw} is not a time zone; running on UTC`}
          note="Use a name from the IANA time zone database, such as Europe/Berlin or Australia/Sydney."
        />
      );
  }
}

function BackupSection({
  state,
  workerConfig,
}: {
  readonly state: InstanceState;
  readonly workerConfig: InstanceConfigState | null;
}): React.JSX.Element {
  const backups = workerConfig?.backups;
  return (
    <Section title="Backups">
      {backups === undefined ? (
        <Row
          label="Nightly backup"
          value="Unknown"
          note="The worker has not reported its configuration yet."
        />
      ) : backups.enabled ? (
        <Row
          label="Nightly backup"
          tone="ok"
          value={`On — encrypted to ${backups.dir}, kept ${backups.retainDays} days`}
          note="Copying that folder off this machine is up to you (docs/BACKUP.md)."
        />
      ) : (
        <Row
          label="Nightly backup"
          tone="warn"
          value="Not configured"
          note={
            <>
              Nothing is being backed up. Set <code>BACKUP_AGE_RECIPIENT</code> as described in{" "}
              <code>docs/BACKUP.md</code>.
            </>
          }
        />
      )}
      {isUnavailable(state.backup) ? (
        <Row label="Last successful backup" value="Unknown" note={UNAVAILABLE_NOTE} />
      ) : (
        <Row
          label="Last successful backup"
          value={state.backup.lastSuccessAt ? when(state.backup.lastSuccessAt) : "None on record"}
          tone={state.backup.lastSuccessAt ? "neutral" : "warn"}
        />
      )}
      <DrillRow drill={state.drill} />
    </Section>
  );
}

function DrillRow({ drill }: { readonly drill: Loaded<DrillStatus> }): React.JSX.Element {
  if (isUnavailable(drill)) {
    return <Row label="Last restore drill" value="Unknown" note={UNAVAILABLE_NOTE} />;
  }
  const value =
    drill.kind === "never"
      ? "Never recorded"
      : `${when(drill.at)} (${drill.ageDays} day${drill.ageDays === 1 ? "" : "s"} ago)`;
  const due = drill.kind === "never" || drill.due;
  return (
    <Row
      label="Last restore drill"
      value={value}
      tone={due ? "warn" : "ok"}
      note={
        <>
          {due ? "A restore should be practised at least every quarter. " : null}
          Follow <code>docs/RESTORE.md</code>, then record it here. This date is what you tell the
          app: it does not check that the restore worked.
          <form action={recordRestoreDrillAction} className="mt-2">
            <button
              type="submit"
              className="rounded-md border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              I completed a restore drill today
            </button>
          </form>
        </>
      }
    />
  );
}

/** Rows for the optional subsystems; worker-owned ones read the worker's own report. */
function SubsystemSection({
  app,
  worker,
}: {
  readonly app: InstanceConfigState;
  readonly worker: InstanceConfigState | null;
}): React.JSX.Element {
  const unknown = "Unknown until the worker reports.";
  return (
    <Section title="Optional features">
      {worker === null ? (
        <Row label="Plain-text ledger copy" value="Unknown" note={unknown} />
      ) : (
        <Row
          label="Plain-text ledger copy"
          tone={worker.beancount.enabled ? "ok" : "neutral"}
          value={worker.beancount.enabled ? "On" : "Off"}
          note={
            worker.beancount.enabled ? undefined : (
              <>
                Optional. A nightly Beancount file you can read without this app. Set{" "}
                <code>BEANCOUNT_DIR</code> (<code>docs/BEANCOUNT.md</code>).
              </>
            )
          }
        />
      )}
      {worker === null ? (
        <Row label="Alert email" value="Unknown" note={unknown} />
      ) : (
        <EmailRow email={worker.email} />
      )}
      <PlaidRows plaid={app.plaid} />
      <Row
        label="Secure session cookie"
        value={app.sessionCookieSecure ? "On (HTTPS only)" : "Off"}
        note={
          app.sessionCookieSecure
            ? undefined
            : "Right for plain-HTTP access on your home network. Set SESSION_COOKIE_SECURE=true if you only ever reach the app over HTTPS."
        }
      />
    </Section>
  );
}

function EmailRow({
  email,
}: {
  readonly email: InstanceConfigState["email"];
}): React.JSX.Element {
  if (email.smtpSet && email.recipientSet) {
    return <Row label="Alert email" value="On" tone="ok" />;
  }
  const missing = [email.smtpSet ? null : "SMTP_URL", email.recipientSet ? null : "ALERT_EMAIL_TO"]
    .filter(Boolean)
    .join(" and ");
  return (
    <Row
      label="Alert email"
      value="Off"
      note={
        <>
          Alerts appear only on the <Link href="/alerts">Alerts</Link> page. To be emailed, set{" "}
          {missing} for the worker (<code>docs/ALERTS.md</code>).
        </>
      }
    />
  );
}

function PlaidRows({
  plaid,
}: {
  readonly plaid: InstanceConfigState["plaid"];
}): React.JSX.Element {
  const keys = plaid.clientIdSet && plaid.secretSet;
  const envValid = plaid.env === "sandbox" || plaid.env === "production";
  return (
    <>
      <Row
        label="Bank connections (Plaid)"
        tone={keys && envValid ? "ok" : "neutral"}
        value={
          keys && envValid ? `On (${plaid.env})` : keys ? "Keys set, environment invalid" : "Off"
        }
        note={
          keys && envValid ? undefined : (
            <>
              Optional; file import works without it. Needs <code>PLAID_CLIENT_ID</code>,{" "}
              <code>PLAID_SECRET</code> and <code>PLAID_ENV</code> set to <code>sandbox</code> or{" "}
              <code>production</code> (<code>docs/PLAID.md</code>).
            </>
          )
        }
      />
      {keys ? (
        <Row
          label="Plaid webhook"
          value={plaid.webhookUrlSet ? "On" : "Off"}
          note={
            plaid.webhookUrlSet
              ? undefined
              : "Optional. Without it, new transactions arrive at the 03:00 daily sync instead of within minutes. Set PLAID_WEBHOOK_URL once the tunnel is up (docs/DEPLOY.md)."
          }
        />
      ) : null}
    </>
  );
}

function LimitsSection({
  limits,
}: {
  readonly limits: InstanceState["limits"];
}): React.JSX.Element {
  const first = limits.years[0];
  const last = limits.years.at(-1);
  const range = first === undefined ? "None" : first === last ? `${first}` : `${first}–${last}`;
  return (
    <Section title="Retirement contribution limits">
      <Row
        label="Years configured"
        value={range}
        tone={limits.currentYearConfigured ? "neutral" : "warn"}
        note={
          limits.firstMissingYear === null ? undefined : (
            <>
              Limits for {limits.firstMissingYear} are not configured, so for that year the
              contribution steps on <Link href="/plan">your plan</Link> say so instead of guessing.
              The IRS publishes them each autumn; add them to{" "}
              <code>src/lib/advice/constants.ts</code>.
            </>
          )
        }
      />
    </Section>
  );
}

/**
 * P19-33(b): the password, changed with the current one. No reset path: a
 * forgotten password is still a deleted `users` row (ADR-004), which
 * docs/DEPLOY.md §Forgotten password spells out for a production stack.
 */
function PasswordSection(): React.JSX.Element {
  return (
    <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">Password</h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Changing it signs out every other browser. There is no reset link: if you forget it, delete
        the user row on the server (<code>docs/DEPLOY.md</code> §Forgotten password) and set a new
        one at the sign-in page. Your data is kept.
      </p>
      <PasswordForm />
    </section>
  );
}
