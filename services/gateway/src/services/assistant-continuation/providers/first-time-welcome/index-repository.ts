// Coverage note: test/services/assistant-continuation/providers/first-time-welcome/first-time-welcome.test.ts
// exercises this module against a functional fake Supabase client (no
// jest.mock of this repository module), so these wrappers get genuine
// coverage, not a documented zero.
/**
 * services/assistant-continuation/providers/first-time-welcome/index.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in first-time-welcome/index.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function updateUserJourneyClearFirstSession(sb: SupabaseClient, userId: string) {
  return sb.from('user_journey').update({ is_first_session: false }).eq('user_id', userId);
}

export async function fetchUserJourneyFirstSessionFlag(sb: SupabaseClient, userId: string) {
  return sb.from('user_journey').select('is_first_session').eq('user_id', userId).maybeSingle();
}
