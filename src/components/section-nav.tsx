"use client";

import type { NavGroupId } from "@/lib/nav/manifest.ts";
import { isCurrent, resolveActive, sectionItemsFor } from "@/lib/nav/resolve.ts";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The second-level tab strip (NAV-09, PLAN_NAV §4.3).
 *
 * Mounted from a section's `layout.tsx` rather than from each page, so it
 * **persists across navigation within the section** instead of remounting — the
 * App Router idiom — and page bodies stay untouched. It is a thin client island
 * only because active state needs `usePathname()`; there is no data fetch and
 * no state.
 *
 * `groupId` is the section the layout speaks for. It is a guard, not the data
 * source: items still come from {@link sectionItemsFor} so a route that
 * resolves into a *different* group (a future nested route reassigned in the
 * manifest) renders no strip rather than a misleading one.
 *
 * Hidden below `sm:` — on mobile these same items are already one tap away in
 * the nav accordion, and rendering both is duplication.
 */
interface Props {
  readonly groupId: NavGroupId;
}

export function SectionNav({ groupId }: Props): React.JSX.Element | null {
  const pathname = usePathname();
  const match = resolveActive(pathname);

  // Route resolves elsewhere (or nowhere) — this layout has nothing to say.
  if (match === null || match.group.id !== groupId) return null;

  const items = sectionItemsFor(pathname);
  if (items.length === 0) return null;

  return (
    <nav
      aria-label={`${match.group.label} sections`}
      className="mx-auto hidden max-w-5xl px-6 sm:block"
    >
      <ul className="flex flex-wrap items-center gap-5 border-zinc-200 border-b py-2 text-sm dark:border-zinc-800">
        {items.map((item) => {
          const current = isCurrent(item, pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                title={item.description}
                className={
                  current
                    ? "font-medium text-zinc-900 dark:text-zinc-50"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
                }
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
