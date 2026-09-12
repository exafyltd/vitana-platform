// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/shopping-agent.ts's existing test suite (test/shopping-agent.test.ts),
// which covers every call site here.
/**
 * routes/shopping-agent.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/shopping-agent.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — the route passes its RLS-scoped user client per-call.
 *
 * This endpoint NEVER checks out or charges (see the file's own header) —
 * every write here is a proposal-only universal_cart_items/universal_carts
 * insert, same as a manual cart add.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== universal_cart_items ====================

export async function insertProposedCartItem(sb: SupabaseClient, payload: Record<string, unknown>) {
  return sb.from('universal_cart_items').insert(payload).select('id').single();
}

// ==================== universal_carts ====================

export async function fetchActiveCartForUser(sb: SupabaseClient, userId: string) {
  return sb.from('universal_carts').select('id').eq('user_id', userId).eq('status', 'active').maybeSingle();
}

export async function insertNewActiveCart(sb: SupabaseClient, userId: string, tenantId: string | null) {
  return sb.from('universal_carts').insert({ user_id: userId, tenant_id: tenantId, status: 'active', metadata: {} }).select('id').single();
}
