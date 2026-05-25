import { userCount } from "@/lib/auth/require-user.ts";
import { redirect } from "next/navigation";
import { SetupForm } from "./setup-form.tsx";

export default async function SetupPage(): Promise<React.JSX.Element> {
  if ((await userCount()) > 0) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md">
        <h1 className="font-semibold text-3xl tracking-tight">First-time setup</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Create the single account that owns this my-money instance. There is no signup flow
          afterwards — this only happens once.
        </p>
        <div className="mt-8">
          <SetupForm />
        </div>
      </div>
    </main>
  );
}
