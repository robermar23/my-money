"use client";

import { Button } from "@/components/ui/button.tsx";
import Link from "next/link";
import { useEffect } from "react";

interface Props {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

/**
 * The error boundary for every page under the root layout.
 *
 * Without it a thrown render (most often Postgres or Redis being unreachable)
 * shows Next's bare default page. This one keeps the nav, says what usually
 * causes it on a self-hosted install, and offers a retry. The error's message
 * is not shown: in production Next replaces it with a digest anyway, and the
 * digest is what matches the line in the server log.
 *
 * Args:
 *   error: The thrown error; `digest` identifies it in the server log.
 *   reset: Re-renders the segment.
 *
 * Returns:
 *   The error panel.
 */
export default function RootError({ error, reset }: Props): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="font-semibold text-2xl tracking-tight">This page could not load</h1>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
        Something failed on the server while building it. On a self-hosted install that is most
        often the database or Redis container being down or still starting. Check the containers and
        the app log, then try again.
      </p>
      {error.digest && (
        <p className="mt-3 text-xs text-zinc-500">
          Error reference: <span className="font-code">{error.digest}</span>
        </p>
      )}
      <div className="mt-6 flex items-center gap-4">
        <Button variant="commit" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className="text-sm underline underline-offset-2">
          Go to the dashboard
        </Link>
      </div>
    </main>
  );
}
