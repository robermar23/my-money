/**
 * Display labels for watchable asset classes (Phase 11). Shared by the list,
 * detail, and add/edit surfaces so the wording stays consistent.
 */
export const WATCHLIST_ASSET_CLASS_LABELS: Record<string, string> = {
  equity: "Stock / ETF",
  crypto: "Crypto",
  physical_metal: "Metal",
};

/** Human label for a watchable asset class, falling back to the raw value. */
export function assetClassLabel(assetClass: string): string {
  return WATCHLIST_ASSET_CLASS_LABELS[assetClass] ?? assetClass;
}
