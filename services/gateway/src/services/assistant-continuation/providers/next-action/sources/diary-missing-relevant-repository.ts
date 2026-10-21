// Genuine coverage: test/services/assistant-continuation/providers/next-action/diary-missing-relevant.test.ts
// passes a hand-built functional fake client directly (no jest.mock())
// — real coverage, not a mock.
/**
 * services/assistant-continuation/providers/next-action/sources/diary-missing-relevant.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md
 * Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in diary-missing-relevant.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserDiaryStreak(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_diary_streak')
    .select('current_streak_days, last_day, longest_streak_days')
    .eq('user_id', userId)
    .maybeSingle();
}
