// Genuine coverage: test/services/memory-orchestrator.test.ts mocks only
// getSupabase() (via jest.mock('../../src/lib/supabase', ...)), not this
// module — a real functional fake client, not a wholesale mock.
/**
 * services/memory-orchestrator.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in memory-orchestrator.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveLifeCompassGoals(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('primary_goal, category')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(3);
}
