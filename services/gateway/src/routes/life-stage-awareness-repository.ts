// Genuine coverage: test/routes/life-stage-awareness.test.ts mocks
// createUserSupabaseClient() at the module boundary (via
// jest.mock('../../src/lib/supabase-user', ...)), not this module, and
// has a dedicated GET /rules test section — a real functional fake
// client, not a wholesale mock of the code under test.
/**
 * routes/life-stage-awareness.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in life-stage-awareness.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter/order logic, same
 * return shape — no behavior change today. Client-agnostic (takes `sb`
 * as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveLifeStageRules(sb: SupabaseClient) {
  return sb
    .from('life_stage_rules')
    .select('rule_key, rule_version, domain, target, weight, active')
    .eq('active', true)
    .order('domain')
    .order('weight', { ascending: false });
}
