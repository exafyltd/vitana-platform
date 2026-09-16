// Genuinely tested via test/conversation-flow-v3-provider.test.ts, which
// drives a real functional fake SupabaseClient (table-keyed, chain-method
// agnostic builder — not a wholesale module mock).
/**
 * services/assistant-continuation/providers/conversation-flow-v3-provider.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in conversation-flow-v3-provider.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same queries, same columns, same conditional-filter
 * logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserIntentIds(sb: SupabaseClient, userId: string) {
  return sb.from('user_intents').select('intent_id').eq('requester_user_id', userId).limit(50);
}

export async function countNewIntentMatches(sb: SupabaseClient, idList: string) {
  return sb
    .from('intent_matches')
    .select('match_id', { count: 'exact', head: true })
    .or(`intent_a_id.in.(${idList}),intent_b_id.in.(${idList})`)
    .eq('state', 'new');
}

export async function fetchUserGuidedJourneyState(sb: SupabaseClient, userId: string) {
  return sb.from('user_guided_journey_state').select('completed_topic_ids, current_session').eq('user_id', userId).maybeSingle();
}

export async function fetchPublishedJourneyChecklistTopicsFromSession(sb: SupabaseClient, fromSession: number) {
  return sb
    .from('journey_checklist_topics')
    .select('topic_id, title, display_label, short_description, vitana_voice_script, manual_path, session, position')
    .eq('status', 'published')
    .eq('enabled', true)
    .gte('session', fromSession)
    .order('session', { ascending: true })
    .order('position', { ascending: true })
    .limit(50);
}

export async function countApprovedPublicMusicUploads(sb: SupabaseClient) {
  return sb
    .from('media_uploads')
    .select('id', { count: 'exact', head: true })
    .eq('media_type', 'music')
    .eq('status', 'approved')
    .eq('is_public', true);
}
