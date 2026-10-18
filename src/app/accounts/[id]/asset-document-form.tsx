"use client";

import { Button } from "@/components/ui/button.tsx";
import { useActionState, useRef } from "react";
import { type ActionResult, uploadAssetDocumentAction } from "./actions.ts";

const initial: ActionResult = {};

const fieldClass =
  "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

interface Props {
  readonly accountId: string;
}

/**
 * Upload a proof-of-authenticity document for an asset (Phase 10, P10-13). The
 * `accept` attribute is a client convenience only — the server re-validates by
 * magic-byte sniff (`detectDocumentType`), the authoritative whitelist. SVG is
 * deliberately excluded from both. The form resets on a successful upload so the
 * next file can be attached.
 */
export function AssetDocumentForm({ accountId }: Props): React.JSX.Element {
  const bound = uploadAssetDocumentAction.bind(null, accountId);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    async (prev: ActionResult, formData: FormData): Promise<ActionResult> => {
      const res = await bound(prev, formData);
      if (res.ok) formRef.current?.reset();
      return res;
    },
    initial,
  );

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <div>
        <label htmlFor="doc-file" className="block font-medium text-xs">
          File
        </label>
        <input
          id="doc-file"
          name="file"
          type="file"
          required
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          className={`${fieldClass} file:mr-3 file:rounded file:border-0 file:bg-zinc-200 file:px-2 file:py-1 file:text-xs dark:file:bg-zinc-800`}
        />
      </div>
      <div>
        <label htmlFor="doc-description" className="block font-medium text-xs">
          Description <span className="text-zinc-400">(optional)</span>
        </label>
        <input
          id="doc-description"
          name="description"
          type="text"
          maxLength={200}
          placeholder="Title, receipt, 2024 appraisal…"
          className={fieldClass}
        />
      </div>
      {state.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-700 text-xs dark:bg-red-950 dark:text-red-300">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-700 text-xs dark:bg-emerald-950 dark:text-emerald-300">
          Uploaded.
        </p>
      )}
      <Button
        type="submit"
        variant="commit"
        pending={pending}
        pendingLabel="Uploading…"
        succeeded={state.ok === true}
      >
        Upload document
      </Button>
    </form>
  );
}
