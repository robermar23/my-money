"use client";

import { useCallback, useState, useTransition } from "react";
import { usePlaidLink } from "react-plaid-link";
import { createLinkTokenAction, exchangePublicTokenAction } from "./actions.ts";

/**
 * "Connect new institution" button (P4-11).
 *
 * Two-stage flow:
 *   1. Click → server action mints a single-use link_token.
 *   2. usePlaidLink opens the Plaid Link popup with that token.
 *   3. On success → server action exchanges public_token for a long-lived
 *      access_token, persists the Item, redirects to the mapping page.
 *
 * Link tokens are NEVER cached — every click re-mints.
 */
export function LinkButton(): React.JSX.Element {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSuccess = useCallback((publicToken: string) => {
    // Hand the public_token to the server action; it does the exchange + redirect.
    startTransition(async () => {
      const result = await exchangePublicTokenAction(publicToken);
      // Successful exchange triggers redirect() server-side; we only land here on error.
      if (result?.error) setError(result.error);
    });
  }, []);

  const onExit = useCallback(() => {
    setLinkToken(null);
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit,
  });

  // When token is set + ready, immediately open the popup.
  if (linkToken && ready) {
    open();
  }

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await createLinkTokenAction();
      if (result.error || !result.linkToken) {
        setError(result.error ?? "Failed to create link token");
        return;
      }
      setLinkToken(result.linkToken);
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? "Opening…" : "Connect new institution"}
      </button>
      {error && <p className="mt-2 text-red-600 text-xs dark:text-red-400">{error}</p>}
    </div>
  );
}
