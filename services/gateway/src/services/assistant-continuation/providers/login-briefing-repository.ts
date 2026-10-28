// Genuine coverage: test/services/assistant-continuation/providers/login-briefing.test.ts
// passes a hand-built proxy-based fake client directly (no jest.mock())
// — real coverage, not a mock.
/**
 * services/assistant-continuation/providers/login-briefing.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * The one Supabase `.from(...)` call in login-briefing.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserJourneyRow(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_journey')
    .select('last_session_date, is_first_session, started_at')
    .eq('user_id', userId)
    .maybeSingle();
}
