// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/match-feedback.ts — zero coverage today.
/**
 * routes/match-feedback.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in match-feedback.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same calls, same params, same columns, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function recordMatchFeedbackRpc(
  sb: SupabaseClient,
  payload: { match_id: string; feedback_type: string; topic_key: string | null; note: string | null },
) {
  return sb.rpc('record_match_feedback', { p_payload: payload });
}

export async function getPersonalizationChangesRpc(
  sb: SupabaseClient,
  args: { p_from: string | null; p_to: string | null; p_limit: number },
) {
  return sb.rpc('get_personalization_changes', args);
}

export async function fetchUserTopicProfileRanked(sb: SupabaseClient) {
  return sb.from('user_topic_profile').select('topic_key, score, source, updated_at').order('score', { ascending: false });
}
