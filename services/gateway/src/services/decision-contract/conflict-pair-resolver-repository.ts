// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: all
// three referencing test files exercise the module exclusively through
// `configureConflictPairResolverForTests`, which seeds the cache
// directly and bypasses `fetchAll()` (the function that holds this
// Supabase call) entirely — zero genuine coverage of the DB fetch path
// today.
/**
 * services/decision-contract/conflict-pair-resolver.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * The one Supabase `.from(...)` call in conflict-pair-resolver.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAllDecisionConflictPairs(sb: SupabaseClient) {
  return sb
    .from('decision_conflict_pair')
    .select('conflict_type, domain_a, domain_b, tenant_id, version, effective_from, effective_until');
}
