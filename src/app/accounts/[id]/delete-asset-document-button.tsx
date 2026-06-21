"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteAssetDocumentAction } from "./actions.ts";

/**
 * Per-row delete control for a proof document (Phase 10, P10-13). Mirrors the
 * holding-delete pattern (useTransition + router.refresh). Confirms first, since
 * it's destructive and the bytes can't be recovered.
 */
export function DeleteAssetDocumentButton({
  accountId,
  docId,
  filename,
}: {
  readonly accountId: string;
  readonly docId: string;
  readonly filename: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete(): void {
    if (!window.confirm(`Delete "${filename}"? This can't be undone.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteAssetDocumentAction(accountId, docId);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        className="text-red-600 text-xs hover:underline disabled:opacity-50 dark:text-red-400"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && <span className="ml-1 text-red-600 text-xs dark:text-red-400">{error}</span>}
    </>
  );
}
