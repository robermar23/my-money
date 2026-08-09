import type { SavingsRateCard } from "@/lib/dashboard/loader.ts";

/**
 * Savings-rate grid slot (Phase 13, P13-13, ADR-029).
 *
 * **This is a seam, not a card.** Phase 13 has no income data to render — income
 * sources and retirement-contribution rules arrive in Phase 14 (ADR-030/031) —
 * so this component renders `null` whenever `data` is absent, which is always,
 * this phase. Its job is to hold the grid position and to make the seam
 * type-checked: the loader's optional `savingsRate` field flows through a real
 * consumer, so PLAN14's P14-17 only has to fill in a body rather than rediscover
 * where the card belongs.
 *
 * @see PLAN14 P14-17 — replaces this body with the real savings-rate card
 *   (rate %, annual employee + employer contributions, "→ Income settings" link).
 */

interface Props {
  /** Undefined until PLAN14's loader wiring populates it. */
  readonly data?: SavingsRateCard;
}

export function SavingsRateSlot({ data }: Props): React.JSX.Element | null {
  if (data === undefined) return null;

  // Unreachable in Phase 13 (the loader never sets the field). Phase 14 replaces
  // this placeholder with the real card rather than extending it.
  return null;
}
