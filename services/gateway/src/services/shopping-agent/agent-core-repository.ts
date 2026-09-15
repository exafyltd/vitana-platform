// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note:
// both referencing test files wholesale jest.mock() this module — zero
// genuine coverage today.
/**
 * services/shopping-agent/agent-core.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in agent-core.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * query, same columns, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 *
 * `buildCandidateProductsAgentQuery` returns only the query-initiating
 * `.from('products').select(...).eq().eq()` builder, `: any` typed, so
 * the source file's ~7 conditional filters (search text, category,
 * health goals, sort, limit) keep mutating it in place exactly as
 * before — the same reasoning already applied to
 * discover-search-repository.ts's buildProductSearchQuery and
 * discover-feed-repository.ts's buildCandidateProductsFeedQuery.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function buildCandidateProductsAgentQuery(sb: SupabaseClient, selectColumns: string): any {
  return sb.from('products').select(selectColumns).eq('is_active', true).eq('availability', 'in_stock');
}
