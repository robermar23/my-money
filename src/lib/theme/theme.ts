/**
 * The colour theme the user picked: follow the device, or force light or dark.
 *
 * Kept in a first-party cookie rather than `localStorage` so the server can put
 * it on `<html>` before the first paint — no flash of the wrong theme and no
 * inline script. The cookie holds only the word below; it is never sent
 * anywhere but back to this app.
 */

/** `system` follows `prefers-color-scheme`; the other two override it. */
export type Theme = "system" | "light" | "dark";

/** Every theme, in the order the picker shows them. */
export const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** The cookie's name. */
export const THEME_COOKIE = "my-money-theme";

/** One year, matching the session's lifetime (ADR-004). */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Read a cookie value as a theme.
 *
 * @param value - The raw cookie value, if any.
 * @returns The theme it names, or `system` for anything missing or unknown.
 */
export function parseTheme(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * The `document.cookie` assignment that stores a theme.
 *
 * @param theme - The theme to store. `system` expires the cookie instead.
 * @returns A string to assign to `document.cookie`.
 */
export function themeCookie(theme: Theme): string {
  const maxAge = theme === "system" ? 0 : MAX_AGE_SECONDS;
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}
