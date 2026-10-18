"use client";

import { THEMES, type Theme, themeCookie } from "@/lib/theme/theme.ts";
import { useId, useState } from "react";

interface Props {
  /** The theme the server rendered with, read from the cookie. */
  readonly initial: Theme;
}

const LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Apply a theme to the page now and remember it for the next request.
 *
 * @param theme - The theme to apply.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  document.cookie = themeCookie(theme);
}

/** A three-way System / Light / Dark choice for the colour theme. */
export function ThemePicker({ initial }: Props): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(initial);
  const name = useId();

  return (
    <fieldset className="px-3 py-2">
      <legend className="mb-1.5 text-xs text-zinc-500">Theme</legend>
      <div className="inline-flex rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700">
        {THEMES.map((option) => (
          <label
            key={option}
            className="cursor-pointer rounded px-2.5 py-1 text-zinc-600 has-checked:bg-zinc-100 has-checked:font-medium has-checked:text-zinc-900 has-focus-visible:outline-2 has-focus-visible:outline-blue-500 dark:text-zinc-400 dark:has-checked:bg-zinc-800 dark:has-checked:text-zinc-50"
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={theme === option}
              onChange={() => {
                setTheme(option);
                applyTheme(option);
              }}
              className="sr-only"
            />
            {LABELS[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
