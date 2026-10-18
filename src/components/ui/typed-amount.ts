/**
 * Formats an amount the user is still typing, for the label of the button that
 * will save it ("Save balance · $1,234.56").
 *
 * Works on the string alone, with no `Number` and no decimal.js, so it is exact
 * for any length and adds nothing to a client bundle. It accepts exactly what
 * `moneyAmountSchema` accepts (an optional minus, digits, up to two decimals),
 * so the button never shows an amount the server would refuse.
 */

const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Formats a typed amount for display, or returns null when it is not valid yet.
 *
 * Args:
 *   raw: The field's current value.
 *   currency: The account's ISO 4217 code. USD shows a "$" prefix; any other
 *     code follows the number.
 *
 * Returns:
 *   The formatted amount, such as "$1,234.50" or "−$80.00", or null.
 */
export function formatTypedAmount(raw: string, currency: string): string | null {
  const match = AMOUNT.exec(raw.trim());
  if (!match) return null;
  const [, sign, whole = "", cents = ""] = match;
  const digits = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const number = `${digits}.${cents.padEnd(2, "0")}`;
  const minus = sign && /[1-9]/.test(whole + cents) ? "−" : "";
  return currency === "USD" ? `${minus}$${number}` : `${minus}${number} ${currency}`;
}
