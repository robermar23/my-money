"use client";

import "./globals.css";
import { useEffect } from "react";

interface Props {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

/**
 * The last-resort boundary, for an error in the root layout itself (it reads
 * the session and the theme cookie, so a broken session store lands here).
 *
 * It replaces the root layout, so it renders its own `<html>` and `<body>` and
 * depends on nothing that could have caused the failure: no nav, no session, no
 * shared components.
 *
 * Args:
 *   error: The thrown error; `digest` identifies it in the server log.
 *   reset: Re-renders the root.
 *
 * Returns:
 *   A full document with the error panel.
 */
export default function GlobalError({ error, reset }: Props): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-50">
        <main className="mx-auto max-w-2xl px-6 py-16">
          <h1 className="font-semibold text-2xl tracking-tight">
            my-money could not start this page
          </h1>
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            The app failed before it could draw anything. Check that the database and Redis
            containers are running and look at the app log.
          </p>
          {error.digest && (
            <p className="mt-3 text-xs text-zinc-500">
              Error reference: <span className="font-code">{error.digest}</span>
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-6 rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
