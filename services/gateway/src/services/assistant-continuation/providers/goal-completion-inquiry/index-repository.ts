// Genuine coverage: test/services/assistant-continuation/providers/goal-completion-inquiry/goal-completion-inquiry.test.ts
// passes a hand-built functional fake client directly (no jest.mock())
// — real coverage, not a mock.
/**
 * services/assistant-continuation/providers/goal-completion-inquiry/index.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md
 * Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in index.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * query, same columns, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveLifeCompassGoal(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('id, primary_goal, target_date, is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
}
