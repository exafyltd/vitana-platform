// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/discover-search.ts — zero coverage
// today.
/**
 * routes/discover-search.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in discover-search.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 *
 * `buildProductSearchQuery` returns only the query-initiating
 * `.from('products').select(...).eq('is_active', true)` builder, `: any`
 * typed, so the source file's ~20 conditional filters (search text,
 * category, health goals, geo scope, sort, pagination) keep mutating it
 * in place exactly as before — moving that branching logic into this
 * repository would risk behavior drift on a builder this complex, the
 * same reasoning already applied to
 * services/recommendation-engine/analyzers/marketplace-analyzer-repository.ts's
 * buildCandidateProductsQuery.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function buildProductSearchQuery(sb: SupabaseClient, selectColumns: string): any {
  return sb.from('products').select(selectColumns, { count: 'exact' }).eq('is_active', true);
}

export async function fetchProductById(
  sb: SupabaseClient,
  id: string,
  selectColumns: string,
): Promise<{ data: any; error: any }> {
  return sb.from('products').select(selectColumns).eq('id', id).eq('is_active', true).maybeSingle();
}
