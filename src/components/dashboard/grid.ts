/**
 * Curated dashboard grid geometry (Phase 13, P13-14, ADR-029 §1).
 *
 * ADR-029 fixes the dashboard's layout in the template — there is no drag/drop,
 * no per-widget config, and no saved-layout table. These constants *are* that
 * fixed layout, shared by [page.tsx](../../app/page.tsx) and the loading
 * skeleton so the placeholders sit exactly where the real cards land.
 *
 * The grid is six columns at `lg` (rather than three) purely so the two
 * chart-bearing cards can take a true half-width: the allocation donut renders
 * its legend beside the chart above `sm`, which needs more room than a third of
 * the page. Read the spans as: **wide = half the row, standard = a third.**
 *
 * - mobile — one column
 * - `sm` — two columns; the chart cards go full-bleed
 * - `lg` — three standard cards per row; two chart cards per row
 */

/** The grid container: 1-up → 2-up → 3-up (as six half-columns). */
export const DASHBOARD_GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6";

/** Half-row card — for the cards that carry a chart (allocation, performance). */
export const SPAN_WIDE = "sm:col-span-2 lg:col-span-3";

/** Standard card — one of three across at `lg`, one of two at `sm`. */
export const SPAN_STANDARD = "lg:col-span-2";
