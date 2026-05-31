import { db } from "@/db/client.ts";
import { importBatches } from "@/db/schema/index.ts";
import { getAccount } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { deleteImportBatchAction } from "../actions.ts";

interface PageProps {
  readonly params: Promise<{ id: string; batchId: string }>;
}

/**
 * Polling page for `pending` batches — the user lands here after uploading a
 * large file that's parsed in the BullMQ worker. The page auto-refreshes
 * every 2s via <meta http-equiv="refresh">; when status flips to 'previewed'
 * we redirect to the preview page server-side.
 *
 * Auto-refresh is intentionally simple (full page refresh) to avoid pulling in
 * a client-side fetcher for a UI surface that's only used during multi-second
 * backfill parses.
 */
export default async function ImportProgressPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { id, batchId } = await props.params;
  const accountId = toAccountId(id);
  const account = await getAccount(accountId);
  if (!account) notFound();

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch || batch.accountId !== accountId) notFound();

  if (batch.status === "previewed") {
    redirect(`/accounts/${accountId}/import/${batch.id}/preview`);
  }
  if (batch.status === "confirmed") {
    redirect(`/accounts/${accountId}?imported=${batch.insertedCount}`);
  }

  const failed = batch.status === "failed";

  return (
    <main className="mx-auto max-w-2xl p-6">
      {!failed && (
        // Auto-refresh every 2s while pending; native + zero-JS.
        <meta httpEquiv="refresh" content="2" />
      )}

      <Link href={`/accounts/${accountId}`} className="text-sm text-zinc-500 hover:underline">
        ← {account.name}
      </Link>
      <h1 className="mt-2 font-semibold text-2xl">Processing import</h1>
      <p className="mt-1 text-sm text-zinc-500">
        File: <span className="font-mono">{batch.filename}</span>
      </p>

      {!failed && (
        <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm">
            Parsing in the background. This page refreshes automatically and will redirect to the
            preview as soon as the parser finishes.
          </p>
          <p className="mt-2 text-xs text-zinc-500">Status: {batch.status}</p>
        </section>
      )}

      {failed && (
        <section className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <p className="font-medium text-red-800 text-sm dark:text-red-200">Import failed</p>
          <p className="mt-1 font-mono text-red-700 text-xs dark:text-red-300">{batch.error}</p>
          <form
            action={async () => {
              "use server";
              await deleteImportBatchAction(accountId, batch.id);
            }}
            className="mt-4"
          >
            <button
              type="submit"
              className="rounded-md border border-red-400 px-3 py-1.5 text-red-800 text-xs hover:bg-red-100 dark:border-red-700 dark:text-red-200 dark:hover:bg-red-900"
            >
              Delete batch &amp; try again
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
