// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/intent-categories.ts — zero coverage
// today.
/**
 * routes/intent-categories.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in intent-categories.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 *
 * `buildIntentCategoriesQuery` returns only the query-initiating
 * `.from('intent_categories').select(...)...order()` builder, `: any`
 * typed, so the source file's one conditional filter (`kind`) keeps
 * mutating it in place exactly as before — the same reasoning already
 * applied to discover-search-repository.ts's buildProductSearchQuery
 * and its siblings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function buildIntentCategoriesQuery(sb: SupabaseClient): any {
  return sb
    .from('intent_categories')
    .select('kind_key, category_key, parent_key, label, sort_order, active')
    .eq('active', true)
    .order('kind_key', { ascending: true })
    .order('sort_order', { ascending: true });
}
