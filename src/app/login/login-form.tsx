"use client";

import { Button } from "@/components/ui/button.tsx";
import { useActionState } from "react";
import { type LoginResult, loginOrBootstrap } from "./actions.ts";

const initial: LoginResult = {};

interface Props {
  readonly isFirstRun: boolean;
}

export function LoginForm({ isFirstRun }: Props): React.JSX.Element {
  const [state, action, pending] = useActionState(loginOrBootstrap, initial);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="password" className="block font-medium text-sm">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          // biome-ignore lint/a11y/noAutofocus: single-field form; cursor belongs here
          autoFocus
          autoComplete={isFirstRun ? "new-password" : "current-password"}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      {state.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
      <Button
        type="submit"
        variant="commit"
        size="md"
        className="w-full"
        pending={pending}
        pendingLabel="..."
      >
        {isFirstRun ? "Set password" : "Sign in"}
      </Button>
    </form>
  );
}
