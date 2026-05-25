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
 */
export const accountTypeEnum = pgEnum("account_type", [
  "depository", // checking, savings
  "credit_card",
  "investment", // brokerage, 401k
  "crypto_ira", // iTrust holds gold + crypto
  "loan", // mortgage
  "property", // home value
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
 */
export const quantityUnitEnum = pgEnum("quantity_unit", ["shares", "coin", "troy_oz", "usd"]);
