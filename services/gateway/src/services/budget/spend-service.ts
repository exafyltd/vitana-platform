/**
 * VTID-03260 — Phase 2 standing-budget read primitive.
 *
 * `getMonthlySpend()` sums the caller's CONVERTED first-party spend for the
 * current calendar month, in ONE currency. It is a pure, service-role READ:
 *
 *   sum(product_orders.amount_cents)
 *     WHERE user_id = <caller>
 *       AND currency = <currency>          -- per-currency only, never mixed
 *       AND state    = 'converted'         -- realized spend only (no pending/refunded/cancelled)
 *       AND purchased_at >= date_trunc('month', now())
 *
 * Money invariant: this module NEVER writes, charges, debits a wallet, or
 * checks out. It only reads product_orders so the budget endpoint + the
 * shopping-agent advisory can reason about standing spend. The cap itself is
 * ADVISORY — nothing here blocks a purchase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const VTID = 'VTID-03260';

/** Start-of-current-month in UTC as an ISO string (mirror of date_trunc('month', now())). */
export function startOfMonthIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

/**
 * Sum CONVERTED first-party spend for the caller in the current month, in the
 * given currency. Returns 0 on any error / missing client (degrade gracefully —
 * an advisory budget surface must never throw the caller's request).
 */
export async function getMonthlySpend(
  supabase: SupabaseClient | null,
  userId: string,
  currency: string
): Promise<number> {
  if (!supabase) return 0;

  const monthStart = startOfMonthIso();

  const { data, error } = await supabase
    .from('product_orders')
    .select('amount_cents')
    .eq('user_id', userId)
    .eq('currency', currency)
    .eq('state', 'converted')
    .gte('purchased_at', monthStart);

  if (error) {
    console.error(`[${VTID}] getMonthlySpend failed for user ${userId}:`, error.message);
    return 0;
  }

  let total = 0;
  for (const row of (data ?? []) as Array<{ amount_cents: number | null }>) {
    const cents = Number(row?.amount_cents ?? 0);
    if (Number.isFinite(cents)) total += cents;
  }
  return total;
}
