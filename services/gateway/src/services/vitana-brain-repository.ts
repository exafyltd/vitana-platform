// Coverage note: test/services/vitana-brain.test.ts exercises this
// module against a mocked '../../lib/supabase' client (a functional
// fake, not a wholesale mock of this repository module), so this
// wrapper gets genuine coverage, not a documented zero.
/**
 * services/vitana-brain.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in vitana-brain.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLatestActiveLifeCompassGoal(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('primary_goal, category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
}
