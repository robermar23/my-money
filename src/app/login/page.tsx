import { userCount } from "@/lib/auth/require-user.ts";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form.tsx";

export default async function LoginPage(): Promise<React.JSX.Element> {
  // First-run case: no users exist yet → go to setup wizard.
  if ((await userCount()) === 0) {
    redirect("/setup");
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md">
        <h1 className="font-semibold text-3xl tracking-tight">my-money</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Sign in to continue.</p>
        <div className="mt-8">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
