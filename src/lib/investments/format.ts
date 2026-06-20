import Decimal from "decimal.js";

/**
 * Display formatting for the /investments dashboard.
 *
 * Money is formatted by `Money.format()` (always 2dp currency). These helpers
 * cover the non-money columns — chiefly share/coin quantities, which arrive as
 * raw `NUMERIC(28,8)` strings (e.g. `"55.00000000"`) and must be trimmed and
 * grouped for human display.
 */

/** Display cap on quantity fraction digits — matches the holdings column scale. */
const MAX_QUANTITY_DECIMALS = 8;

/**
 * Format a holding quantity for display: drop trailing zeros, group thousands.
 *
 * Examples: `"55.00000000"` → `"55"`, `"1631.34300000"` → `"1,631.343"`,
 * `"0.18894857"` → `"0.18894857"`.
 *
 * @param raw - The quantity as a decimal string (NUMERIC(28,8)).
 * @returns A trimmed, thousands-grouped string. `"0"` for unparseable input.
 */
export function formatQuantity(raw: string): string {
  let dec: Decimal;
  try {
    dec = new Decimal(raw);
  } catch {
    return "0";
  }
  // Round to the column's scale, then let Intl drop trailing zeros + group.
  const trimmed = dec.toDecimalPlaces(MAX_QUANTITY_DECIMALS, Decimal.ROUND_HALF_UP);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: MAX_QUANTITY_DECIMALS,
  }).format(trimmed.toNumber());
}
