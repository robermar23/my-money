import { getAccount } from "@/lib/accounts/queries.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { toAccountId } from "@/lib/types/ids.ts";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { UploadForm } from "./upload-form.tsx";

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function ImportUploadPage(props: PageProps): Promise<React.JSX.Element> {
  await requireUser();
  const { id } = await props.params;
  const accountId = toAccountId(id);
  const account = await getAccount(accountId);
  if (!account) notFound();
  if (account.type !== "depository" && account.type !== "credit_card") {
    redirect(`/accounts/${accountId}`);
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link href={`/accounts/${accountId}`} className="text-sm text-zinc-500 hover:underline">
        ← {account.name}
      </Link>
      <h1 className="mt-2 font-semibold text-2xl tracking-tight">Import transactions</h1>
      <p data-tour="import-intro" className="mt-1 text-sm text-zinc-500">
        Upload an OFX/QFX or CSV export. The next page lets you preview the parsed transactions
        before anything is written to your account.
      </p>

      <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <UploadForm accountId={account.id} accountType={account.type} />
      </section>
    </main>
  );
}
