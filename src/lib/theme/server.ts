import { cookies } from "next/headers";
import { THEME_COOKIE, type Theme, parseTheme } from "./theme.ts";

/**
 * The theme stored for this browser.
 *
 * @returns The stored theme, or `system` when none is set.
 */
export async function readTheme(): Promise<Theme> {
  const store = await cookies();
  return parseTheme(store.get(THEME_COOKIE)?.value);
}
