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
