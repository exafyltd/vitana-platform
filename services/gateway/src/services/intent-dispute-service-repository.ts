// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in intent-dispute-service.ts has any test coverage today —
// test/orb-tools/discovery-tools.test.ts mocks this module wholesale
// (jest.mock('../../src/services/intent-dispute-service', ...)), and
// neither of this module's two route callers (src/routes/intent-matches.ts,
// src/routes/admin-intent-engine.ts) has a test file. This is a pure
// mechanical move, verified by tsc — flagged here rather than silently
// presented as covered.
/**
 * services/intent-dispute-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-dispute-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — the source file still owns creating the client via its own
 * getSupabase() and passes it in, exactly as before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchIntentMatchForDispute(sb: SupabaseClient, matchId: string) {
  return sb
    .from('intent_matches')
    .select('match_id, intent_a_id, intent_b_id, kind_pairing')
    .eq('match_id', matchId)
    .maybeSingle();
}

export async function fetchIntentRequesterUserId(sb: SupabaseClient, intentId: string) {
  return sb.from('user_intents').select('requester_user_id').eq('intent_id', intentId).maybeSingle();
}

export async function insertIntentDispute(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('intent_disputes').insert(row).select('*').single();
}

export async function fetchDisputesForMatch(sb: SupabaseClient, matchId: string) {
  return sb.from('intent_disputes').select('*').eq('match_id', matchId).order('created_at', { ascending: false });
}

export async function updateIntentDisputeResolution(sb: SupabaseClient, disputeId: string, patch: Record<string, unknown>) {
  return sb.from('intent_disputes').update(patch).eq('dispute_id', disputeId).select('*').single();
}

export async function fetchOpenIntentDisputes(sb: SupabaseClient, limit: number) {
  return sb
    .from('intent_disputes')
    .select('*')
    .in('status', ['open', 'investigating'])
    .order('created_at', { ascending: true })
    .limit(limit);
}
