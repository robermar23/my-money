import { openAlertCount } from "@/lib/alerts/queries.ts";
import type { BadgeSlot } from "@/lib/nav/manifest.ts";
import { readTheme } from "@/lib/theme/server.ts";
import Link from "next/link";
import { CommandPalette } from "./command-palette.tsx";
import { HelpPanel } from "./help/help-panel.tsx";
import { TourChip } from "./help/tour-chip.tsx";
import { TourRunner } from "./help/tour.tsx";
import { NavBar } from "./nav-bar.tsx";

/**
 * Top navigation chrome shown on authenticated pages.
 *
 * Stays a **server component**: it performs the one I/O the nav needs — the
 * open-alert count — and hands the interactive body to the {@link NavBar}
 * client island (ADR-035). The manifest itself never performs I/O, so badge
 * counts arrive here as a `badges` map keyed by {@link BadgeSlot}. Adding a
 * second badge (e.g. the uncategorized count on Planning → Review queue) is one
 * loader line and one manifest field, not a refactor of the chrome.
 *
 * `relative` anchors the mobile dropdown panel (`top-full`).
 */
export async function AppNav(): Promise<React.JSX.Element> {
  const [alertCount, theme] = await Promise.all([openAlertCount(), readTheme()]);
  const badges: Partial<Record<BadgeSlot, number>> = { alerts: alertCount };

  return (
    <header className="relative border-zinc-200 border-b dark:border-zinc-800">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3"
      >
        <Link href="/" className="font-semibold tracking-tight">
          my-money
        </Link>
        <NavBar badges={badges} theme={theme} />
      </nav>
      {/* Mounted once at the chrome level so ⌘K works on every authenticated page. */}
      <CommandPalette />
      {/* Likewise the help panel: `?` works on every page with no page edited (ADR-058). */}
      <HelpPanel />
      {/* Tours start only from a click: the panel's button or this first-visit chip (ADR-060 §4). */}
      <TourChip />
      <TourRunner />
    </header>
  );
}
