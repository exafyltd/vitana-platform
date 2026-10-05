/**
 * VTID-04878 — DB access for the reward sweep. All read-only candidate
 * queries are SQL functions (migration 20261005100000) so the test/service
 * account exclusion lives in one place next to claim_capped_reward().
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export function fetchSweepMembers(sb: SupabaseClient, after: string | null, limit: number) {
  return sb.rpc('reward_sweep_members', { p_after: after, p_limit: limit });
}

export function fetchLiveRoomCandidates(sb: SupabaseClient, sinceIso: string) {
  return sb.rpc('reward_sweep_live_room_candidates', { p_since: sinceIso });
}

export function fetchIndexCandidates(sb: SupabaseClient, sinceDate: string) {
  return sb.rpc('reward_sweep_index_candidates', { p_since: sinceDate });
}
