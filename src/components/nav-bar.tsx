"use client";

import {
  type BadgeSlot,
  NAV_GROUPS,
  NAV_UTILITIES,
  type NavGroup,
  type NavGroupId,
  type NavItem,
} from "@/lib/nav/manifest.ts";
import { isCurrent, resolveActive } from "@/lib/nav/resolve.ts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { OPEN_COMMAND_PALETTE_EVENT } from "./command-palette.tsx";
import { HelpButton } from "./help/help-button.tsx";
import { NavGroupMenu } from "./nav-group-menu.tsx";

/**
 * The top bar (NAV-06/07, ADR-035).
 *
 * Renders **entirely from the nav manifest** — there is not one hard-coded
 * destination below this line. Five group triggers plus three utilities
 * (search, alerts, account) replace the flat 12-link row that had outgrown its
 * `max-w-5xl` container; adding a destination now edits
 * [manifest.ts](../lib/nav/manifest.ts) and nothing here.
 *
 * At `sm:` and up it is a row of disclosure menus; below that, the existing
 * hamburger panel, now grouped into collapsible sections with the current
 * group expanded on open.
 *
 * **State budget: two `useState`s** — which desktop group is open, and whether
 * the mobile panel is open (plus which accordion section it shows). Per
 * CLAUDE.md §Zustand, server components come first and a store is for state
 * shared across *unrelated* client components; this is neither.
 */

/** Open the single mounted ⌘K palette without prop-drilling or a shared store. */
function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

/** Dynamic counts, resolved by the server and keyed by manifest badge slot. */
export type BadgeCounts = Partial<Record<BadgeSlot, number>>;

interface Props {
  readonly badges: BadgeCounts;
}

/**
 * A count beside a label. The digits are `aria-hidden` and a screen-reader
 * phrase carries the meaning — a bare red circle announcing "3" is not a label
 * (PLAN_NAV §4.4).
 */
function Badge({ count, noun }: { readonly count: number; readonly noun: string }) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 font-medium text-white text-xs"
      >
        {count}
      </span>
      <span className="sr-only">
        {count} open {noun}
        {count === 1 ? "" : "s"}
      </span>
    </>
  );
}

/** The badge count for an item, or 0 when it declares no badge slot. */
function badgeFor(item: NavItem, badges: BadgeCounts): number {
  return item.badge ? (badges[item.badge] ?? 0) : 0;
}

function SignOut(): React.JSX.Element {
  return (
    <form action="/logout" method="post">
      <button
        type="submit"
        className="w-full px-3 py-2 text-left text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Sign out
      </button>
    </form>
  );
}

function SearchIcon({ className }: { readonly className: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      role="img"
      aria-hidden="true"
    >
      <title>Search</title>
      <circle cx="11" cy="11" r="7" strokeWidth="2" />
      <path strokeWidth="2" strokeLinecap="round" d="m20 20-3.5-3.5" />
    </svg>
  );
}

function BellIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      role="img"
      aria-hidden="true"
    >
      <title>Alerts</title>
      <path
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"
      />
    </svg>
  );
}

/**
 * One link inside a desktop dropdown panel: label plus its one-line description.
 *
 * The description is `aria-hidden` and wired up with `aria-describedby` rather
 * than left in the link's content. That keeps the **accessible name** exactly
 * the destination's label — "Watchlist", not "Watchlist Symbols you track and
 * their price targets" — while the blurb is still announced, as a description,
 * and still sits inside the click target where it belongs visually.
 */
function PanelLink({
  item,
  pathname,
  badges,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly badges: BadgeCounts;
  readonly onNavigate: () => void;
}): React.JSX.Element {
  const current = isCurrent(item, pathname);
  const descriptionId = useId();
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={current ? "page" : undefined}
        aria-describedby={descriptionId}
        className={`block px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
          current ? "bg-zinc-50 dark:bg-zinc-800" : ""
        }`}
      >
        <span
          className={`flex items-center gap-1.5 ${
            current ? "font-medium text-zinc-900 dark:text-zinc-50" : ""
          }`}
        >
          {item.label}
          <Badge count={badgeFor(item, badges)} noun="alert" />
        </span>
        <span id={descriptionId} aria-hidden="true" className="mt-0.5 block text-xs text-zinc-500">
          {item.description}
        </span>
      </Link>
    </li>
  );
}

export function NavBar({ badges }: Props): React.JSX.Element {
  const pathname = usePathname();
  const [openGroup, setOpenGroup] = useState<NavGroupId | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<NavGroupId | null>(null);

  const activeGroupId = resolveActive(pathname)?.group.id ?? null;
  const alertCount = badges.alerts ?? 0;

  // A route change closes every disclosure — the panel that navigated you is
  // stale the moment the new page renders. `pathname` is the *trigger*, not a
  // value the effect reads, which is exactly the case Biome's dependency rule
  // cannot see.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger.
  useEffect(() => {
    setOpenGroup(null);
    setMobileOpen(false);
  }, [pathname]);

  /** Open the mobile panel with the current route's group already expanded. */
  const toggleMobile = (): void => {
    setMobileOpen((wasOpen) => {
      if (!wasOpen) setExpandedGroup(activeGroupId);
      return !wasOpen;
    });
  };

  const closeAll = (): void => {
    setOpenGroup(null);
    setMobileOpen(false);
  };

  /** A group with a single item is a plain link — a one-entry dropdown is friction. */
  const renderGroup = (group: NavGroup): React.JSX.Element => {
    const only = group.items.length === 1 ? group.items[0] : undefined;
    if (only) {
      const current = isCurrent(only, pathname);
      return (
        <Link
          key={group.id}
          href={only.href}
          aria-current={current ? "page" : undefined}
          className={`py-1 ${
            current
              ? "font-medium text-zinc-900 underline underline-offset-8 dark:text-zinc-50"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
          }`}
        >
          {group.label}
        </Link>
      );
    }

    return (
      <NavGroupMenu
        key={group.id}
        label={group.label}
        active={activeGroupId === group.id}
        open={openGroup === group.id}
        onOpenChange={(next) => setOpenGroup(next ? group.id : null)}
      >
        <ul aria-label={`${group.label} pages`} className="text-sm">
          {group.items.map((item) => (
            <PanelLink
              key={item.href}
              item={item}
              pathname={pathname}
              badges={badges}
              onNavigate={closeAll}
            />
          ))}
        </ul>
      </NavGroupMenu>
    );
  };

  return (
    <>
      {/* ── Desktop: group triggers, then right-aligned utilities ───────────── */}
      <div className="hidden items-center gap-5 text-sm sm:flex">
        {NAV_GROUPS.map(renderGroup)}

        <span aria-hidden="true" className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />

        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="Search (Command or Control + K)"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex items-center gap-2 rounded-md border border-zinc-300 px-2 py-1 text-zinc-500 hover:text-zinc-900 dark:border-zinc-700 dark:hover:text-zinc-50"
        >
          <span>Search…</span>
          <kbd className="rounded bg-zinc-100 px-1 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">
            ⌘K
          </kbd>
        </button>

        <HelpButton variant="icon" />

        {NAV_UTILITIES.map((item) => {
          const current = isCurrent(item, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={`flex items-center gap-1.5 py-1 ${
                current
                  ? "font-medium text-zinc-900 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-50"
              }`}
            >
              <BellIcon />
              <span className="sr-only">{item.label}</span>
              <Badge count={badgeFor(item, badges)} noun="alert" />
            </Link>
          );
        })}

        <NavGroupMenu
          label={<span aria-hidden="true">⋯</span>}
          srLabel="Account menu"
          align="right"
          open={openGroup === "utilities"}
          onOpenChange={(next) => setOpenGroup(next ? "utilities" : null)}
        >
          <div className="text-sm">
            <SignOut />
          </div>
        </NavGroupMenu>
      </div>

      {/* ── Mobile: hamburger ───────────────────────────────────────────────── */}
      <button
        type="button"
        aria-label="Toggle navigation menu"
        aria-expanded={mobileOpen}
        onClick={toggleMobile}
        className="relative flex h-10 w-10 items-center justify-center rounded-md text-zinc-700 hover:bg-zinc-100 sm:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          role="img"
          aria-hidden="true"
        >
          <title>Menu</title>
          {mobileOpen ? (
            <path strokeWidth="2" strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          ) : (
            <path strokeWidth="2" strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
        {!mobileOpen && alertCount > 0 && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-600" />
        )}
      </button>

      {/* ── Mobile: grouped accordion panel ─────────────────────────────────── */}
      {mobileOpen && (
        <div className="absolute inset-x-0 top-full z-20 border-zinc-200 border-b bg-white sm:hidden dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex max-w-5xl flex-col px-6 py-2 text-sm">
            <button
              type="button"
              aria-label="Search"
              onClick={() => {
                setMobileOpen(false);
                openCommandPalette();
              }}
              className="flex items-center gap-1.5 py-2.5 text-left text-zinc-600 dark:text-zinc-400"
            >
              <SearchIcon className="h-4 w-4" />
              Search
            </button>
            <HelpButton variant="row" onOpen={() => setMobileOpen(false)} />

            {NAV_GROUPS.map((group) => {
              const only = group.items.length === 1 ? group.items[0] : undefined;
              if (only) {
                return (
                  <Link
                    key={group.id}
                    href={only.href}
                    onClick={closeAll}
                    aria-current={isCurrent(only, pathname) ? "page" : undefined}
                    className={`py-2.5 ${
                      isCurrent(only, pathname)
                        ? "font-medium text-zinc-900 dark:text-zinc-50"
                        : "text-zinc-600 dark:text-zinc-400"
                    }`}
                  >
                    {group.label}
                  </Link>
                );
              }

              const expanded = expandedGroup === group.id;
              return (
                <div key={group.id} className="border-zinc-100 border-t dark:border-zinc-900">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedGroup(expanded ? null : group.id)}
                    className={`flex w-full items-center justify-between py-2.5 text-left ${
                      activeGroupId === group.id
                        ? "font-medium text-zinc-900 dark:text-zinc-50"
                        : "text-zinc-600 dark:text-zinc-400"
                    }`}
                  >
                    {group.label}
                    <svg
                      viewBox="0 0 24 24"
                      className={`h-4 w-4 transition-transform motion-reduce:transition-none ${
                        expanded ? "rotate-180" : ""
                      }`}
                      fill="none"
                      stroke="currentColor"
                      role="img"
                      aria-hidden="true"
                    >
                      <title>Toggle {group.label}</title>
                      <path
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="m6 9 6 6 6-6"
                      />
                    </svg>
                  </button>
                  {expanded && (
                    <ul aria-label={`${group.label} pages`} className="pb-1 pl-3">
                      {group.items.map((item) => (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={closeAll}
                            aria-current={isCurrent(item, pathname) ? "page" : undefined}
                            className={`block py-2 ${
                              isCurrent(item, pathname)
                                ? "font-medium text-zinc-900 dark:text-zinc-50"
                                : "text-zinc-600 dark:text-zinc-400"
                            }`}
                          >
                            {item.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}

            {NAV_UTILITIES.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeAll}
                aria-current={isCurrent(item, pathname) ? "page" : undefined}
                className={`flex items-center gap-1.5 border-zinc-100 border-t py-2.5 dark:border-zinc-900 ${
                  isCurrent(item, pathname)
                    ? "font-medium text-zinc-900 dark:text-zinc-50"
                    : "text-zinc-600 dark:text-zinc-400"
                }`}
              >
                {item.label}
                <Badge count={badgeFor(item, badges)} noun="alert" />
              </Link>
            ))}

            <div className="border-zinc-100 border-t py-1 dark:border-zinc-900">
              <SignOut />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
