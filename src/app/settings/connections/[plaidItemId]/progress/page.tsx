import { db } from "@/db/client.ts";
import { plaidItems } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProgressPanel } from "./progress-panel.tsx";

interface PageProps {
  params: Promise<{ plaidItemId: string }>;
}

export default async function SyncProgressPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { plaidItemId: plaidItemPk } = await props.params;

  const [item] = await db
    .select({ id: plaidItems.id, institutionName: plaidItems.institutionName })
    .from(plaidItems)
    .where(eq(plaidItems.id, plaidItemPk))
    .limit(1);
  if (!item) notFound();

  return (
    <main className="mx-auto max-w-xl p-6">
      <Link href="/settings/connections" className="text-sm text-zinc-500 hover:underline">
        ← Connections
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Syncing {item.institutionName}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Plaid is pulling up to 24 months of history. This usually takes under a minute, but a long
        backfill can take a few. You can leave the page; sync continues in the background.
      </p>

      <div className="mt-6">
        <ProgressPanel plaidItemPk={item.id} />
      </div>
    </main>
  );
}
