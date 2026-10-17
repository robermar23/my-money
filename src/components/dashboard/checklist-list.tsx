import type { ChecklistItem } from "@/lib/help/checklist.ts";
import Link from "next/link";

/**
 * The getting-started items as a list (PLAN20 P20-30). Shared by the first-run
 * page and the dashboard's dismissible card, so it holds no state of its own.
 *
 * An item still to do links to the page where it is done and, where that page
 * has one, to its tour. A done item is ticked and no longer links.
 */
export function ChecklistList({
  items,
}: {
  readonly items: readonly ChecklistItem[];
}): React.JSX.Element {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id} className="flex gap-3">
          <span
            aria-hidden="true"
            className={
              item.done
                ? "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white text-xs dark:bg-emerald-500 dark:text-zinc-950"
                : "mt-0.5 h-5 w-5 shrink-0 rounded-full border border-zinc-300 dark:border-zinc-700"
            }
          >
            {item.done ? "✓" : null}
          </span>
          <div className="min-w-0 text-sm">
            <p
              className={
                item.done ? "text-zinc-500 line-through dark:text-zinc-400" : "font-medium"
              }
            >
              {item.done || item.href === null ? (
                item.title
              ) : (
                <Link href={item.href} className="hover:underline">
                  {item.title}
                </Link>
              )}
              <span className="sr-only">{item.done ? " (done)" : " (to do)"}</span>
            </p>
            {item.done ? null : (
              <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">
                {item.detail}
                {item.tourHref === null ? null : (
                  <>
                    {" "}
                    <Link href={item.tourHref} className="whitespace-nowrap underline">
                      Take the tour
                    </Link>
                  </>
                )}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
