// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references routes/health-capacity.ts — zero coverage
// today.
/**
 * routes/health-capacity.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in health-capacity.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter/order logic, same
 * return shape — no behavior change today. Client-agnostic (takes `sb`
 * as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveCapacityRules(sb: SupabaseClient) {
  return sb
    .from('capacity_rules')
    .select('rule_key, rule_version, signal_source, target_dimension, weight, decay_minutes, active')
    .eq('active', true)
    .order('signal_source')
    .order('weight', { ascending: false });
}
