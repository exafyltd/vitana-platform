// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/intent-board.ts — zero coverage today.
/**
 * routes/intent-board.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in intent-board.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same filters, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 *
 * `buildIntentBoardQuery` returns only the query-initiating
 * `.from('user_intents').select(...)...order().limit()` builder,
 * `: any` typed, so the source file's many further conditional filters
 * (partner_seek surface gating, category prefix/exact filters) keep
 * mutating it in place exactly as before — the same reasoning already
 * applied to discover-search-repository.ts's buildProductSearchQuery
 * and its siblings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function buildIntentBoardQuery(
  sb: SupabaseClient,
  tenantId: string | null,
  userId: string,
  kinds: string[],
  limit: number,
): any {
  return sb
    .from('user_intents')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .in('intent_kind', kinds)
    // never show me my own intents on the board
    .neq('requester_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}
