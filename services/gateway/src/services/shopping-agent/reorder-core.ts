/**
 * VTID-03260 — Phase 2 reorder core.
 *
 * `buildReorderPicks()` turns the caller's past_purchases (from the health
 * context brain) into AnnotatedPicks suitable for the SAME insertPick path the
 * /propose handler uses. It:
 *
 *   1. dedupes past_purchases by product_id (keeping the most-recent purchase),
 *   2. hydrates each product_id from `products`,
 *   3. DROPS any product that is not (is_active && availability='in_stock') — so
 *      a reordered line survives the checkout re-validation gate downstream,
 *   4. re-snapshots the CURRENT price_cents + currency (never reuses the old
 *      snapshot),
 *   5. derives item_type via deriveItemType,
 *   6. attaches a short neutral rationale + empty safety_flags (unless the
 *      product carries safety_notes).
 *
 * Money invariant: this module READS products and product-purchase history. It
 * NEVER checks out, charges, debits a wallet, or writes product_orders. The
 * picks it returns are proposals — the route inserts them as universal_cart_items.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserHealthContext } from '../user-health-context';
import { deriveItemType, type AnnotatedPick } from './agent-core';

export const VTID = 'VTID-03260';

/** Columns we hydrate for a reorder candidate. */
const REORDER_PRODUCT_COLUMNS =
  'id, title, category, price_cents, currency, safety_notes, is_active, availability';

interface ReorderProductRow {
  id: string;
  title: string | null;
  category: string | null;
  price_cents: number | null;
  currency: string | null;
  safety_notes: string | null;
  is_active: boolean | null;
  availability: string | null;
}

/**
 * One reorder pick carries the same AnnotatedPick shape as a /propose pick,
 * plus the previously_purchased_at the route stamps into metadata.
 */
export interface ReorderPick extends AnnotatedPick {
  previously_purchased_at: string;
}

/**
 * Build reorder picks from the caller's past_purchases. Returns at most
 * `maxItems` picks, in most-recently-purchased-first order. Out-of-stock /
 * inactive SKUs are dropped so the reordered lines stay purchasable.
 */
export async function buildReorderPicks(
  supabase: SupabaseClient | null,
  ctx: UserHealthContext,
  maxItems: number
): Promise<ReorderPick[]> {
  if (!supabase) return [];

  // 1. Dedupe by product_id, keeping the most-recent purchased_at. past_purchases
  //    arrives newest-first (product_orders ordered purchased_at DESC), so the
  //    first occurrence wins.
  const firstSeen = new Map<string, string>(); // product_id -> purchased_at
  const order: string[] = [];
  for (const p of ctx.past_purchases) {
    if (!p.product_id) continue;
    if (firstSeen.has(p.product_id)) continue;
    firstSeen.set(p.product_id, p.purchased_at);
    order.push(p.product_id);
  }
  if (order.length === 0) return [];

  // 2. Hydrate from products (single batched read).
  const { data, error } = await supabase
    .from('products')
    .select(REORDER_PRODUCT_COLUMNS)
    .in('id', order);

  if (error) {
    console.error(`[${VTID}] buildReorderPicks product hydrate failed:`, error.message);
    return [];
  }

  const byId = new Map<string, ReorderProductRow>();
  for (const row of (data ?? []) as ReorderProductRow[]) {
    if (row?.id) byId.set(row.id, row);
  }

  // 3. Walk in purchase-recency order, drop non-in-stock/inactive, build picks.
  const picks: ReorderPick[] = [];
  for (const productId of order) {
    if (picks.length >= maxItems) break;
    const row = byId.get(productId);
    if (!row) continue;
    // DROP anything not currently purchasable so reordered lines survive checkout
    // re-validation.
    if (row.is_active !== true || row.availability !== 'in_stock') continue;

    const safetyFlags: string[] = [];
    if (row.safety_notes && row.safety_notes.trim()) safetyFlags.push('has_safety_notes');

    picks.push({
      product_id: row.id,
      title: row.title ?? 'Product',
      // Neutral server-side rationale key-ish text; the FE localizes via origin.
      rationale: 'Previously purchased — reorder',
      safety_flags: safetyFlags,
      // Reorders are high-confidence by definition (the user already bought it).
      confidence: 0.9,
      item_type: deriveItemType(row.category),
      // 4. Re-snapshot CURRENT price + currency (never reuse the old snapshot).
      unit_price_cents_snapshot: row.price_cents ?? null,
      currency_snapshot: row.currency ?? null,
      previously_purchased_at: firstSeen.get(productId)!,
    });
  }

  return picks;
}
