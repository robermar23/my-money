import type { InputUsed } from "@/lib/advice/types.ts";
import Link from "next/link";

/**
 * The audit trail under every recommendation and rung (P15-33, ADR-032 §2).
 *
 * This is the component that makes the whole feature falsifiable. A user who
 * reads "build your emergency fund to $18,000" and thinks *that is nowhere near
 * my expenses* needs to be able to see, without leaving the page, that the figure
 * came from a median of nine months of spend in categories they marked essential
 * — and then follow one link to the categories they have not classified yet.
 *
 * Without this, a wrong number is indistinguishable from a broken app, and the
 * only available conclusion is to stop trusting the whole surface. ADR-032 §2
 * makes `inputsUsed[]` part of the `Recommendation` contract for exactly that
 * reason, and this renders it.
 *
 * ── `null` is rendered, not skipped ────────────────────────────────────────
 * A missing input is the *most* important row in the list: it is the one the
 * user can act on. It shows as "not recorded" in amber with its fix link, never
 * as a blank cell, an em dash alone, or a zero.
 */

interface Props {
  readonly inputs: readonly InputUsed[];
  /** Heading text; defaults to the audit-trail label. */
  readonly label?: string;
}

/** Suffix a value with its unit so a bare number is never ambiguous. */
function formatValue(input: InputUsed): string {
  if (input.value === null) return "not recorded";
  switch (input.kind) {
    case "percent":
      return `${input.value}%`;
    case "months":
      return `${input.value} months`;
    default:
      return input.value;
  }
}

export function InputsUsed({ inputs, label = "Based on" }: Props): React.JSX.Element | null {
  if (inputs.length === 0) return null;

  return (
    <details className="mt-3 text-xs">
      <summary
        data-tour="inputs-used"
        className="cursor-pointer text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
      >
        {label} {inputs.length} {inputs.length === 1 ? "input" : "inputs"}
      </summary>
      <ul className="mt-2 space-y-1.5 border-zinc-200 border-l pl-3 dark:border-zinc-800">
        {inputs.map((input) => (
          <li key={`${input.label}:${input.source}`}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{input.label}</span>
              <span
                className={`font-mono tabular-nums ${
                  input.value === null ? "text-amber-700 dark:text-amber-400" : ""
                }`}
              >
                {formatValue(input)}
              </span>
              {input.href && (
                <Link href={input.href} className="text-zinc-500 underline hover:text-zinc-900">
                  {input.missing || input.value === null ? "add it" : "check"}
                </Link>
              )}
            </div>
            <div className="text-zinc-500">{input.source}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}
