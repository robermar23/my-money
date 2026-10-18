"use client";

import { Button } from "@/components/ui/button.tsx";
import { useTransition } from "react";
import { deleteRuleAction, recategorizeAllAction, toggleRuleAction } from "./actions.ts";

export function ToggleRule({
  ruleId,
  enabled,
}: {
  ruleId: string;
  enabled: boolean;
}): React.JSX.Element {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      disabled={pending}
      onClick={() => start(() => toggleRuleAction(ruleId, !enabled))}
      variant="secondary"
      size="xs"
    >
      {enabled ? "Disable" : "Enable"}
    </Button>
  );
}

export function DeleteRule({ ruleId }: { ruleId: string }): React.JSX.Element {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      disabled={pending}
      onClick={() => start(() => deleteRuleAction(ruleId))}
      variant="danger-quiet"
      size="xs"
    >
      Delete
    </Button>
  );
}

export function RecategorizeAllButton(): React.JSX.Element {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      onClick={() =>
        start(async () => {
          const { updated } = await recategorizeAllAction();
          alert(`Re-categorized ${updated} transaction${updated === 1 ? "" : "s"}.`);
        })
      }
      variant="secondary"
      pending={pending}
      pendingLabel="Re-categorizing…"
    >
      Re-categorize existing transactions
    </Button>
  );
}
