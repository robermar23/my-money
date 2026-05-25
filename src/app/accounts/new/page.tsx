import { requireUser } from "@/lib/auth/require-user.ts";
import { NewAccountForm } from "./new-account-form.tsx";

export default async function NewAccountPage(): Promise<React.JSX.Element> {
  await requireUser();
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="font-semibold text-2xl tracking-tight">Add account</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Pick the account type that matches the real-world account you're tracking. Different types
        unlock different entry flows on the account detail page.
      </p>
      <div className="mt-6">
        <NewAccountForm />
      </div>
    </main>
  );
}
