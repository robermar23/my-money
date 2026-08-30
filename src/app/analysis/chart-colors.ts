/**
 * Shared categorical color palette for the analysis charts (ADR-005/013).
 *
 * A category's color is assigned by its stable position in the sorted category
 * list so the same category keeps the same color across the donut, the stacked
 * bar, and its trend line. Colors are Tailwind-500 hexes (legible in both light
 * and dark mode).
 */
export const CHART_COLORS: readonly string[] = [
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#eab308", // yellow
  "#6366f1", // indigo
  "#14b8a6", // teal
  "#f97316", // orange
] as const;

/** Pick a palette color by index, wrapping around for long lists. */
export function colorForIndex(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] as string;
}

/**
 * Semantic colors for the net-worth waterfall (P17-21, ADR-039 §4).
 *
 * Deliberately NOT drawn from {@link CHART_COLORS}: that palette assigns color
 * by position so a category keeps its color across three charts, and position
 * carries no meaning. Here color IS the meaning — a bar's hue says whether the
 * money went up, went down, or is unaccounted for — so the two must not share a
 * source and quietly drift into each other.
 *
 * `unknown` is amber rather than a third "bad" hue because `unexplained` is
 * neither good nor bad; it is the app admitting it cannot say. Amber already
 * means exactly that everywhere else in this app (the `InputsUsed` "not
 * recorded" row), and the waterfall additionally dashes that bar's outline so
 * it stays separable from the loss color without relying on hue alone.
 */
export const WATERFALL_COLORS = {
  /** Opening and closing anchors — a fact, not a movement. */
  anchor: "#71717a", // zinc-500
  /** A rung that raised net worth. */
  up: "#10b981", // emerald-500
  /** A rung that lowered it. */
  down: "#ef4444", // red-500
  /** `unexplained`. Not a loss, not a gain — unknown. */
  unknown: "#f59e0b", // amber-500
} as const;
