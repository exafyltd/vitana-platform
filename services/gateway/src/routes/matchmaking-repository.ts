// impact-allow-no-test: pure data-access seam (thin Supabase RPC/query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/matchmaking.ts — zero coverage today.
/**
 * routes/matchmaking.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same queries, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function recomputeDailyMatchesRpc(sb: SupabaseClient, matchDate: unknown) {
  return sb.rpc('match_recompute_daily', { p_user_id: null, p_date: matchDate });
}

export async function getDailyMatchesRpc(sb: SupabaseClient, matchDate: unknown) {
  return sb.rpc('match_get_daily', { p_user_id: null, p_date: matchDate });
}

export async function setMatchStateRpc(sb: SupabaseClient, matchId: unknown, state: unknown) {
  return sb.rpc('match_set_state', { p_match_id: matchId, p_state: state });
}

export async function fetchMatchUsersAndTenant(sb: SupabaseClient, matchId: string) {
  return sb.from('user_matches').select('user_id, matched_user_id, tenant_id').eq('id', matchId).single();
}

export async function fetchMatchTenantId(sb: SupabaseClient, matchId: string) {
  return sb.from('user_matches').select('tenant_id').eq('id', matchId).maybeSingle();
}

export async function fetchUsersWithSuggestedMatches(sb: SupabaseClient, matchDate: unknown, minScore: unknown) {
  return sb.from('matches_daily').select('user_id').eq('match_date', matchDate).eq('state', 'suggested').gte('score', minScore);
}
