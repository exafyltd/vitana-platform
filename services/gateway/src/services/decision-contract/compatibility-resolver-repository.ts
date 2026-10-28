// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note:
// same shape as the sibling conflict-pair-resolver.ts — every
// referencing test exercises the module exclusively through
// `configureCompatibilityResolverForTests`, which seeds the cache
// directly and bypasses `fetchAll()` (the function that holds this
// Supabase call) entirely — zero genuine coverage of the DB fetch path
// today.
/**
 * services/decision-contract/compatibility-resolver.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * The one Supabase `.from(...)` call in compatibility-resolver.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAllDecisionCompatibilityScores(sb: SupabaseClient) {
  return sb
    .from('decision_compatibility_score')
    .select(
      'dimension, profile_value, candidate_value, score, tenant_id, ' +
        'version, effective_from, effective_until',
    );
}
