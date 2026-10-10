import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Account types — the seven real-world account shapes from FEATURE.md, plus
 * 'property' for home/real-estate assets.
 *
 * Discriminated UI behavior:
 *   - depository/credit_card: balance-only (manual or QFX import)
 *   - investment/crypto_ira: holdings-based (qty × price)
 *   - loan: amortization-driven (no manual balance entry)
 *   - property: most-recent valuation snapshot
 *   - personal_asset: user-valued high-value item (vehicle/boat/jewelry/etc.) —
 *     same most-recent valuation-snapshot model as property, plus asset metadata
 *     columns + proof documents (Phase 10, ADR-023). Counts toward net worth.
 *
 * Author-shaped, on purpose (ADR-053 §3): `crypto_ira` exists because the
 * author holds metals and crypto in an iTrust IRA. There is no `hsa`, `529` or
 * `cash` member: `investment` already models an HSA or 529 brokerage account,
 * and a member nobody holds is speculative schema. Adding one is one migration;
 * the trigger is a real household with that account, not generality.
 */
export const accountTypeEnum = pgEnum("account_type", [
  "depository", // checking, savings
  "credit_card",
  "investment", // brokerage, 401k
  "crypto_ira", // iTrust holds gold + crypto
  "loan", // mortgage
  "property", // home value
  "personal_asset", // vehicles, boats, jewelry, collectibles (manual value over time)
]);

/**
 * Asset class on holdings. Drives valuation logic:
 *   - equity / crypto: looked up in `prices` by symbol
 *   - physical_metal: looked up in `prices` by 'XAU'/'XAG'/etc.
 *   - cash: face value (quantity is the dollar amount)
 *   - property: face value (single holding per property account)
 */
export const assetClassEnum = pgEnum("asset_class", [
  "equity",
  "crypto",
  "physical_metal",
  "cash",
  "property",
]);

/**
 * Unit of measure for `holdings.quantity`. Matched against asset_class:
 *   - shares → equity
 *   - coin → crypto
 *   - troy_oz → physical_metal (gold/silver bullion in oz)
 *   - usd → cash, property
 *
 * These are the units the author owns (ADR-053 §3). No grams, no kilos, no bond
 * par value: a metal bought by the gram is entered in troy ounces. Adding a
 * unit is one migration plus its valuation path, whenever a real holding needs
 * it.
 */
export const quantityUnitEnum = pgEnum("quantity_unit", ["shares", "coin", "troy_oz", "usd"]);
