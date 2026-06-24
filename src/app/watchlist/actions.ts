"use server";

import { db } from "@/db/client.ts";
import { priceTargets, watchlistItems } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { backfillWatchlistSymbolQueue } from "@/lib/queue/queues.ts";
import {
  createPriceTargetSchema,
  createWatchlistItemSchema,
  updateWatchlistItemSchema,
} from "@/lib/schemas/watchlist.ts";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const UUID_RE = /^[0-9a-f-]{36}$/i;

export interface WatchlistActionResult {
  error?: string;
}

/** Postgres unique-violation code (duplicate `(symbol, asset_class)`). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

/** Best-effort enqueue of the on-add history backfill (never blocks the action). */
async function enqueueBackfill(watchlistItemId: string): Promise<void> {
  try {
    await backfillWatchlistSymbolQueue.add("backfill-watchlist-symbol", { watchlistItemId });
  } catch (err) {
    // The watch row already exists and gets live closes nightly; a failed
    // enqueue (e.g. Redis down) just means a shorter chart until then.
    console.error("[watchlist] backfill enqueue failed:", err);
  }
}

/**
 * Create a watchlist item (P11-16, ADR-025), then kick the history backfill and
 * redirect to its detail page. The pretend trio is validated all-or-nothing in
 * the schema; the DB CHECK is the backstop. A duplicate `(symbol, asset_class)`
 * is surfaced as a friendly error rather than a 500.
 */
export async function createWatchlistItemAction(
  _prev: WatchlistActionResult,
  formData: FormData,
): Promise<WatchlistActionResult> {
  await requireUser();

  const parsed = createWatchlistItemSchema.safeParse({
    symbol: formData.get("symbol"),
    assetClass: formData.get("assetClass"),
    label: formData.get("label") ?? "",
    pretendQuantity: formData.get("pretendQuantity") ?? "",
    pretendUnitCost: formData.get("pretendUnitCost") ?? "",
    pretendPurchasedAt: formData.get("pretendPurchasedAt") ?? "",
    currency: formData.get("currency") || "USD",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  let createdId: string;
  try {
    const [created] = await db
      .insert(watchlistItems)
      .values({
        symbol: d.symbol,
        assetClass: d.assetClass,
        label: d.label ?? null,
        pretendQuantity: d.pretendQuantity ?? null,
        pretendUnitCost: d.pretendUnitCost ?? null,
        pretendPurchasedAt: d.pretendPurchasedAt ?? null,
        currency: d.currency,
        notes: d.notes ?? null,
      })
      .returning({ id: watchlistItems.id });
    if (!created) return { error: "Failed to create watchlist item" };
    createdId = created.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: `You're already watching ${d.symbol} (${d.assetClass}). Edit it instead.` };
    }
    throw err;
  }

  await enqueueBackfill(createdId);
  revalidatePath("/watchlist");
  redirect(`/watchlist/${createdId}`);
}

/**
 * Edit a watchlist item (P11-16). Re-enqueues the backfill (idempotent) so a
 * changed pretend purchase date extends the chart window.
 */
export async function updateWatchlistItemAction(
  id: string,
  _prev: WatchlistActionResult,
  formData: FormData,
): Promise<WatchlistActionResult> {
  await requireUser();
  if (!UUID_RE.test(id)) return { error: "Invalid item" };

  const parsed = updateWatchlistItemSchema.safeParse({
    symbol: formData.get("symbol"),
    assetClass: formData.get("assetClass"),
    label: formData.get("label") ?? "",
    pretendQuantity: formData.get("pretendQuantity") ?? "",
    pretendUnitCost: formData.get("pretendUnitCost") ?? "",
    pretendPurchasedAt: formData.get("pretendPurchasedAt") ?? "",
    currency: formData.get("currency") || "USD",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  try {
    await db
      .update(watchlistItems)
      .set({
        symbol: d.symbol,
        assetClass: d.assetClass,
        label: d.label ?? null,
        pretendQuantity: d.pretendQuantity ?? null,
        pretendUnitCost: d.pretendUnitCost ?? null,
        pretendPurchasedAt: d.pretendPurchasedAt ?? null,
        currency: d.currency,
        notes: d.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(watchlistItems.id, id));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: `Another watch row already uses ${d.symbol} (${d.assetClass}).` };
    }
    throw err;
  }

  await enqueueBackfill(id);
  revalidatePath("/watchlist");
  revalidatePath(`/watchlist/${id}`);
  redirect(`/watchlist/${id}`);
}

/**
 * Delete a watchlist item (P11-19). Cascades its `price_targets`; leaves shared
 * `prices` rows (cheap, and they serve a re-add). Net worth is untouched — a
 * watch row never counted toward it.
 */
export async function deleteWatchlistItemAction(id: string): Promise<void> {
  await requireUser();
  if (!UUID_RE.test(id)) return;
  await db.delete(watchlistItems).where(eq(watchlistItems.id, id));
  revalidatePath("/watchlist");
  redirect("/watchlist");
}

/**
 * Add a one-shot price target to a watchlist item (P11-18). The item id is bound
 * server-side (not a client field), so the form only supplies direction +
 * threshold.
 */
export async function createPriceTargetAction(
  watchlistItemId: string,
  _prev: WatchlistActionResult,
  formData: FormData,
): Promise<WatchlistActionResult> {
  await requireUser();
  if (!UUID_RE.test(watchlistItemId)) return { error: "Invalid item" };

  const parsed = createPriceTargetSchema.safeParse({
    direction: formData.get("direction"),
    threshold: formData.get("threshold"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Guard the FK: the item must exist (a stale page could post a deleted id).
  const [item] = await db
    .select({ id: watchlistItems.id })
    .from(watchlistItems)
    .where(eq(watchlistItems.id, watchlistItemId))
    .limit(1);
  if (!item) return { error: "Watchlist item no longer exists" };

  await db.insert(priceTargets).values({
    watchlistItemId,
    direction: parsed.data.direction,
    threshold: parsed.data.threshold,
    note: parsed.data.note ?? null,
  });

  revalidatePath(`/watchlist/${watchlistItemId}`);
  return {};
}

/**
 * Toggle a target's armed state (P11-18). Pausing sets `active = false`;
 * re-arming sets `active = true` and clears the prior trigger stamps so it can
 * fire again on the next evaluation.
 */
export async function togglePriceTargetAction(
  targetId: string,
  watchlistItemId: string,
): Promise<void> {
  await requireUser();
  if (!UUID_RE.test(targetId) || !UUID_RE.test(watchlistItemId)) return;

  const [target] = await db
    .select({ active: priceTargets.active })
    .from(priceTargets)
    .where(and(eq(priceTargets.id, targetId), eq(priceTargets.watchlistItemId, watchlistItemId)))
    .limit(1);
  if (!target) return;

  const nowActive = !target.active;
  await db
    .update(priceTargets)
    .set({
      active: nowActive,
      // Re-arming clears the one-shot stamps so it can trigger afresh.
      triggeredAt: nowActive ? null : undefined,
      triggeredPrice: nowActive ? null : undefined,
      updatedAt: new Date(),
    })
    .where(eq(priceTargets.id, targetId));

  revalidatePath(`/watchlist/${watchlistItemId}`);
}

/** Delete a single price target (P11-18). */
export async function deletePriceTargetAction(
  targetId: string,
  watchlistItemId: string,
): Promise<void> {
  await requireUser();
  if (!UUID_RE.test(targetId) || !UUID_RE.test(watchlistItemId)) return;
  await db
    .delete(priceTargets)
    .where(and(eq(priceTargets.id, targetId), eq(priceTargets.watchlistItemId, watchlistItemId)));
  revalidatePath(`/watchlist/${watchlistItemId}`);
}
