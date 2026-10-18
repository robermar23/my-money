"use client";

import { Button } from "@/components/ui/button.tsx";
import { useTransition } from "react";
import { confirmImportAction } from "../../actions.ts";

interface Props {
  readonly accountId: string;
  readonly batchId: string;
  readonly disabled: boolean;
  readonly insertCount: number;
}

export function ConfirmButton({
  accountId,
  batchId,
  disabled,
  insertCount,
}: Props): React.JSX.Element {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={() => {
        startTransition(async () => {
          await confirmImportAction(accountId, batchId);
        });
      }}
    >
      <Button
        type="submit"
        disabled={disabled || insertCount === 0}
        variant="commit"
        size="md"
        pending={pending}
        pendingLabel="Importing…"
      >
        {insertCount === 0
          ? "Nothing to import"
          : `Confirm import of ${insertCount} transaction${insertCount === 1 ? "" : "s"}`}
      </Button>
    </form>
  );
}
