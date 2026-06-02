"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { type SyncProgressSnapshot, getSyncProgressAction } from "../../progress-actions.ts";

const POLL_INTERVAL_MS = 3_000;
/** Once status flips to a terminal value, wait this long before redirecting to the dashboard. */
const COMPLETE_REDIRECT_DELAY_MS = 1_500;

interface Props {
  plaidItemPk: string;
}

/**
 * P4-23 — Initial-sync progress poller.
 *
 * Polls every 3s. Stops polling and (after a brief pause so the user sees the
 * final state) redirects to the dashboard when status leaves the in-flight
 * 'syncing' state. Surfaces error/reauth states inline rather than redirecting.
 */
export function ProgressPanel({ plaidItemPk }: Props): React.JSX.Element {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<SyncProgressSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      try {
        const snap = await getSyncProgressAction(plaidItemPk);
        if (cancelled) return;
        setSnapshot(snap);
        if (snap.status === "syncing") {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        } else if (snap.status === "active") {
          // Terminal happy path — let the user see "X synced" then redirect.
          if (!redirectTimer.current) {
            redirectTimer.current = setTimeout(() => {
              router.push("/");
            }, COMPLETE_REDIRECT_DELAY_MS);
          }
        }
        // login_required, pending_disconnect, revoked, removed → keep the panel
        // open with the inline message; don't redirect.
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        timer = setTimeout(tick, POLL_INTERVAL_MS * 2);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, [plaidItemPk, router]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-sm dark:border-red-950 dark:bg-red-950 dark:text-red-200">
        {error}
      </div>
    );
  }
  if (!snapshot) {
    return <p className="text-sm text-zinc-500">Starting sync…</p>;
  }

  return (
    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex items-center gap-3">
        <StatusBadge status={snapshot.status} />
        <span className="text-sm text-zinc-500">
          {snapshot.status === "syncing" ? "Polling every 3s" : "Up to date"}
        </span>
      </div>

      <div className="mt-4">
        <p className="font-semibold text-3xl tracking-tight">
          {snapshot.transactionsCount.toLocaleString()}
        </p>
        <p className="mt-0.5 text-sm text-zinc-500">transactions synced</p>
      </div>

      {snapshot.latestRun && (
        <div className="mt-5 grid grid-cols-3 gap-2 text-center text-xs">
          <RunCounter label="Added" value={snapshot.latestRun.addedCount} />
          <RunCounter label="Modified" value={snapshot.latestRun.modifiedCount} />
          <RunCounter label="Removed" value={snapshot.latestRun.removedCount} />
        </div>
      )}

      {snapshot.latestRun?.paginationCount && snapshot.latestRun.paginationCount > 1 && (
        <p className="mt-3 text-xs text-zinc-500">
          {snapshot.latestRun.paginationCount} page
          {snapshot.latestRun.paginationCount === 1 ? "" : "s"} fetched
        </p>
      )}

      {snapshot.latestRun?.error && (
        <p className="mt-3 rounded bg-red-50 px-2 py-1 text-red-800 text-xs dark:bg-red-950 dark:text-red-200">
          {snapshot.latestRun.error}
        </p>
      )}

      {snapshot.status === "active" && (
        <p className="mt-4 text-emerald-700 text-sm dark:text-emerald-300">
          Sync complete — redirecting to the dashboard…
        </p>
      )}
      {snapshot.status === "login_required" && (
        <p className="mt-4 text-amber-800 text-sm dark:text-amber-300">
          Plaid needs you to reconnect this institution. Open the{" "}
          <a href="/settings/connections" className="underline">
            Connections page
          </a>
          .
        </p>
      )}
      {snapshot.status === "revoked" && (
        <p className="mt-4 text-red-700 text-sm dark:text-red-300">
          Connection was revoked. Disconnect and re-link from the Connections page.
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SyncProgressSnapshot["status"] }): React.JSX.Element {
  const styles: Record<SyncProgressSnapshot["status"], string> = {
    syncing: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
    active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    login_required: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    pending_disconnect: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    revoked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    removed: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  };
  const label =
    status === "syncing"
      ? "Syncing…"
      : status === "active"
        ? "Active"
        : status === "login_required"
          ? "Reconnect needed"
          : status === "pending_disconnect"
            ? "Pending disconnect"
            : status === "revoked"
              ? "Revoked"
              : "Removed";
  return (
    <span className={`rounded px-2 py-0.5 font-medium text-xs ${styles[status]}`}>{label}</span>
  );
}

function RunCounter({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded border border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      <div className="font-mono">{value}</div>
      <div className="text-zinc-500">{label}</div>
    </div>
  );
}
