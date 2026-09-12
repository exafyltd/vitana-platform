// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/intent-open-asks.ts — zero coverage
// today.
/**
 * routes/intent-open-asks.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in intent-open-asks.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 *
 * `buildOpenAsksQuery` returns only the query-initiating
 * `.from('intent_open_asks').select(...).order().limit()` builder,
 * `: any` typed, so the source file's three conditional filters
 * (cursor, kind, category_prefix) keep mutating it in place exactly as
 * before — the same reasoning already applied to
 * discover-search-repository.ts's buildProductSearchQuery and its
 * siblings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function buildOpenAsksQuery(sb: SupabaseClient, limit: number): any {
  return sb
    .from('intent_open_asks')
    .select('intent_id, requester_vitana_id, intent_kind, category, title, scope, kind_payload, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
}
