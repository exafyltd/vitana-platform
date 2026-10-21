// Coverage note: test/services/assistant-continuation/providers/new-day-return.test.ts
// exercises this module against a functional fake Supabase client
// passed directly as `inputs.supabase` (no jest.mock of this repository
// module), so these wrappers get genuine coverage, not a documented
// zero.
/**
 * services/assistant-continuation/providers/new-day-return.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in new-day-return.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function updateUserJourneyLastSessionDate(sb: SupabaseClient, userId: string, todayIso: string) {
  return sb.from('user_journey').update({ last_session_date: todayIso }).eq('user_id', userId);
}

export async function fetchUserJourneyRow(sb: SupabaseClient, userId: string) {
  return sb.from('user_journey').select('last_session_date, is_first_session').eq('user_id', userId).maybeSingle();
}
