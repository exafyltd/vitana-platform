// impact-allow-no-test: pure data-access seam (thin Supabase query/update
// wrappers, no independent request-handling behavior). Coverage note: the
// one test file referencing intent-mutual-reveal.ts
// (test/services/conversation/intent-matches-speakable.test.ts) wholesale
// jest.mocks the module — zero genuine coverage today.
/**
 * services/intent-mutual-reveal.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-mutual-reveal.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchMatchRevealState(sb: SupabaseClient, matchId: string) {
  return sb
    .from('intent_matches')
    .select('mutual_reveal_unlocked_at, intent_a_id, intent_b_id')
    .eq('match_id', matchId)
    .maybeSingle();
}

export async function fetchIntentRequesterUserId(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('requester_user_id').eq('intent_id', intentId).maybeSingle();
}

export async function fetchMatchForUnlock(sb: SupabaseClient, matchId: string) {
  return sb
    .from('intent_matches')
    .select('match_id, kind_pairing, state, mutual_reveal_unlocked_at, vitana_id_a, vitana_id_b')
    .eq('match_id', matchId)
    .maybeSingle();
}

export async function updateMutualRevealUnlockedAt(sb: SupabaseClient, matchId: string, unlockedAtIso: string) {
  return sb
    .from('intent_matches')
    .update({ mutual_reveal_unlocked_at: unlockedAtIso })
    .eq('match_id', matchId);
}
