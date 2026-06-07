"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  type PlaidProduct,
  createLinkTokenAction,
  exchangePublicTokenAction,
  finalizeReauthAction,
} from "./actions.ts";

/**
 * Dual-purpose Plaid Link launcher.
 *
 *   - mode='connect': "Connect new institution" CTA (P4-11). Plaid Link opens
 *     in initial-link mode; onSuccess hands the public_token to the exchange
 *     action, which persists the Item and redirects to the mapping page.
 *
 *   - mode='update':  "Reconnect" button for items in login_required state
 *     (P4-25). Plaid Link opens in UPDATE mode (the link_token was minted
 *     with the existing access_token). On success there is NO public_token
 *     to exchange — the existing token stays valid. We call
 *     finalizeReauthAction to flip status back to 'active' and kick off a
 *     sync to catch up missed transactions.
 *
 * Link tokens are NEVER cached — every click mints a fresh one (CLAUDE.md
 * §Plaid Safety Rules: "Link tokens are single-use").
 */

export type LinkButtonMode = "connect" | "update";

interface Props {
  mode?: LinkButtonMode;
  /** Required when mode='update'. Plaid Link opens in reauth mode for this Item. */
  plaidItemPk?: string;
  /** Optional label override; defaults to the mode-appropriate text. */
  label?: string;
  /** Tailwind variant for the button colour. Defaults to primary; 'amber' for reauth CTA. */
  variant?: "primary" | "amber";
  /**
   * Products to consent to in connect mode (P5-10). Defaults to
   * `['transactions']`; pass `['investments']` for the Fidelity brokerage CTA.
   * Ignored in update mode.
   */
  products?: PlaidProduct[];
}

export function LinkButton({
  mode = "connect",
  plaidItemPk,
  label,
  variant = "primary",
  products,
}: Props): React.JSX.Element {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSuccess = useCallback(
    (publicToken: string) => {
      startTransition(async () => {
        if (mode === "update") {
          if (!plaidItemPk) {
            setError("Reauth flow is missing the Item id.");
            return;
          }
          const result = await finalizeReauthAction(plaidItemPk);
          if (result.error) {
            setError(result.error);
            return;
          }
          // Stay on the connections page; refresh so the new status shows.
          router.refresh();
        } else {
          const result = await exchangePublicTokenAction(publicToken, products);
          // Successful exchange redirects server-side; we only land here on error.
          if (result?.error) setError(result.error);
        }
      });
    },
    [mode, plaidItemPk, products, router],
  );

  const onExit = useCallback(() => {
    setLinkToken(null);
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit,
  });

  if (linkToken && ready) {
    open();
  }

  const handleClick = () => {
    setError(null);
    if (mode === "update" && !plaidItemPk) {
      setError("Reauth flow is missing the Item id.");
      return;
    }
    startTransition(async () => {
      const result = await createLinkTokenAction(
        mode === "update" ? { plaidItemPk } : { products },
      );
      if (result.error || !result.linkToken) {
        setError(result.error ?? "Failed to create link token");
        return;
      }
      setLinkToken(result.linkToken);
    });
  };

  const buttonText = label ?? (mode === "update" ? "Reconnect" : "Connect new institution");
  const buttonClass =
    variant === "amber"
      ? "rounded-md bg-amber-500 px-3 py-1.5 font-medium text-sm text-white hover:bg-amber-600 disabled:opacity-50"
      : "rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200";

  return (
    <div>
      <button type="button" onClick={handleClick} disabled={pending} className={buttonClass}>
        {pending ? "Opening…" : buttonText}
      </button>
      {error && <p className="mt-2 text-red-600 text-xs dark:text-red-400">{error}</p>}
    </div>
  );
}
