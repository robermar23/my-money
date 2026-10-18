import type { HelpRoute } from "./routes.ts";
import type { TourDefinition } from "./types.ts";

/**
 * Opening the help panel from anywhere (PLAN20 P20-06).
 *
 * The panel is mounted once in the chrome, like the ⌘K palette, and opens on a
 * window event. The `?` buttons and the palette dispatch it, so nothing needs a
 * prop or a shared store to reach the panel.
 */

/** Window event that opens the help panel. */
export const OPEN_HELP_EVENT = "money:open-help";

/** What the open event carries. */
export interface OpenHelpDetail {
  /**
   * Show this pattern's help instead of the current page's. The palette uses
   * it for a page with an `<id>`, which has no concrete path to navigate to.
   */
  readonly route?: HelpRoute;
}

/**
 * Open the single mounted help panel.
 *
 * @param route - Optional pattern to explain; defaults to the current page.
 */
export function openHelp(route?: HelpRoute): void {
  const detail: OpenHelpDetail = route === undefined ? {} : { route };
  window.dispatchEvent(new CustomEvent<OpenHelpDetail>(OPEN_HELP_EVENT, { detail }));
}

/** Form controls where `?` is text, not a shortcut. */
const TYPING_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Whether a key event's target is somewhere the user is typing.
 *
 * Typing a question mark into a payee search must never open a dialog, so the
 * `?` shortcut is ignored in inputs, textareas, selects, and contenteditable.
 *
 * @param target - The key event's target.
 * @returns `true` when the key belongs to the field, not to the shortcut.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as { readonly tagName?: unknown; readonly isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  return typeof el.tagName === "string" && TYPING_TAGS.has(el.tagName.toUpperCase());
}

/**
 * The URL fragment that asks for a page's tour (PLAN20 P20-30). A link to
 * `/analysis/review#tour` opens the page with its tour running; the first-visit
 * chip, mounted on every page, acts on it and then removes it.
 */
export const TOUR_HASH = "#tour";

/** Window event that starts a tour on the current page (PLAN20 P20-16). */
export const START_TOUR_EVENT = "money:start-tour";

/** What the start event carries. */
export interface StartTourDetail {
  readonly tour: TourDefinition;
}

/**
 * Start a tour in the single mounted tour runner.
 *
 * The panel and the first-visit chip both start tours this way; the runner
 * resolves the steps against the page as it is when the event arrives.
 *
 * @param tour - The page's tour.
 */
export function startTour(tour: TourDefinition): void {
  window.dispatchEvent(new CustomEvent<StartTourDetail>(START_TOUR_EVENT, { detail: { tour } }));
}
