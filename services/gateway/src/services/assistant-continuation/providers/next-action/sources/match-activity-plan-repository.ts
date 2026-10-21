// Coverage note: test/services/assistant-continuation/providers/next-action/match-activity-plan.test.ts
// exercises this module against a hand-built functional fake Supabase
// client passed directly as `ctx.supabase` (no jest.mock of this
// repository module), so these wrappers get genuine coverage, not a
// documented zero.
/**
 * services/assistant-continuation/providers/next-action/sources/match-activity-plan.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in match-activity-plan.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserIntentIds(sb: SupabaseClient, userId: string, maxIntents: number) {
  return sb
    .from('user_intents')
    .select('intent_id')
    .eq('requester_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(maxIntents);
}

export async function fetchIntentMatchesForIntentIds(sb: SupabaseClient, idListOrExpr: string, maxMatches: number) {
  return sb
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, kind_pairing, state, mutual_reveal_unlocked_at')
    .or(idListOrExpr)
    .in('state', ['new', 'responded_by_a', 'responded_by_b', 'mutual_interest'])
    .order('match_id', { ascending: true })
    .limit(maxMatches);
}
