// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in routes/intent-matches.ts has any test coverage today — no
// test file in this repo references this route (the only match on
// "intent-matches" is test/services/conversation/intent-matches-speakable.test.ts,
// which covers a different module — services/conversation/intent-matches-speakable.ts).
/**
 * routes/intent-matches.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/intent-matches.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * routes/intent-matches.ts's /:id/dispute handler dynamically imports
 * raiseDispute from services/intent-dispute-service.ts — that module's own
 * Supabase calls were already seamed separately (VTID-03702, same day) and
 * are out of scope here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchOwnedIntentIds(sb: SupabaseClient, userId: string) {
  return sb.from('user_intents').select('intent_id').eq('requester_user_id', userId);
}

export async function fetchOutgoingIntentMatches(sb: SupabaseClient, intentIds: string[], limit: number) {
  return sb.from('intent_matches').select('*').in('intent_a_id', intentIds).order('score', { ascending: false }).limit(limit);
}

export async function fetchIncomingIntentMatches(sb: SupabaseClient, intentIds: string[], limit: number) {
  return sb.from('intent_matches').select('*').in('intent_b_id', intentIds).order('score', { ascending: false }).limit(limit);
}

export async function fetchIntentMatchForStateTransition(sb: SupabaseClient, matchId: string) {
  return sb
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, state, vitana_id_a, vitana_id_b, kind_pairing')
    .eq('match_id', matchId)
    .maybeSingle();
}

export async function fetchIntentMatchForDecline(sb: SupabaseClient, matchId: string) {
  return sb
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, state, kind_pairing')
    .eq('match_id', matchId)
    .maybeSingle();
}

/** Reused for every owner-of-intent-A/B authorization check across /:id/state and /:id/decline. */
export async function fetchIntentRequesterUserId(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('requester_user_id').eq('intent_id', intentId).maybeSingle();
}

/** Reused for both /:id/state and /:id/decline — same update shape, different `state` value. */
export async function updateIntentMatchState(sb: SupabaseClient, matchId: string, state: string) {
  return sb.from('intent_matches').update({ state }).eq('match_id', matchId);
}
