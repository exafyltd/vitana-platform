// Genuine coverage: test/services/spend-service.test.ts passes a
// hand-built recording fake client directly (no jest.mock()) and
// asserts on the exact filters applied — real coverage, not a mock.
/**
 * services/budget/spend-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in spend-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same filters, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 *
 * Money-adjacent (product_orders) — kept as a byte-for-byte move, no
 * scoping/filter logic touched.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchConvertedProductOrderAmounts(
  sb: SupabaseClient,
  userId: string,
  currency: string,
  monthStartIso: string,
) {
  return sb
    .from('product_orders')
    .select('amount_cents')
    .eq('user_id', userId)
    .eq('currency', currency)
    .eq('state', 'converted')
    .gte('purchased_at', monthStartIso);
}
