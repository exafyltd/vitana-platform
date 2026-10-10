// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note:
// test/vtid-04878-reward-earning.test.ts mocks this module to cover
// milestone-service.ts (VTID-04878).
/**
 * services/milestone-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in milestone-service.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 *
 * emitMilestoneEvent's raw fetch() POST to the PostgREST oasis_events
 * endpoint is out of scope for this seam — it bypasses the supabase-js
 * client entirely, same as the feedback_handoff_events writes in
 * routes/feedback-intake.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAchievedMilestoneRefs(sb: SupabaseClient, userId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('source_ref')
    .eq('user_id', userId)
    .eq('source_type', 'milestone')
    .eq('status', 'completed');
}

export async function insertAchievedMilestone(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('autopilot_recommendations').insert(row);
}

export async function fetchAppUserForProfileCheck(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name, avatar_url:profile->>avatar_url').eq('user_id', userId).maybeSingle();
}

export async function countUserTopicProfileRows(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('user_topic_profile')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}

export async function countDiaryMemoryItems(sb: SupabaseClient, userId: string) {
  return sb.from('memory_items').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('item_type', 'diary');
}

export async function countConnectedRelationshipEdges(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('target_type', 'person')
    .eq('relationship_type', 'connected');
}

export async function countGroupRelationshipEdges(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('target_type', 'group');
}

// VTID-04878: RSVPs live in global_event_participants (status 'attending').
// community_meetup_attendance was never created, so first_event_rsvp could
// never fire.
export async function countRsvpMeetupAttendance(sb: SupabaseClient, userId: string) {
  return sb.from('global_event_participants').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'attending');
}

// VTID-04878: onboarding_complete pays at signup (owner decision 2026-10-05) —
// a primary tenant membership is the signal that the member signed up.
export async function countPrimaryMemberships(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('user_id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_primary', true);
}

export async function countAcceptedDailyMatches(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('matches_daily')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('state', 'accepted');
}

export async function fetchRecentDiaryEntryDates(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('memory_items')
    .select('created_at')
    .eq('user_id', userId)
    .eq('item_type', 'diary')
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function countVitanaIndexScoreRows(sb: SupabaseClient, userId: string) {
  return sb.from('vitana_index_scores').select('id', { count: 'exact', head: true }).eq('user_id', userId);
}

export async function countSuccessfulReferrals(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('referrer_id', userId)
    .in('status', ['signed_up', 'activated', 'rewarded']);
}

export async function creditWalletForMilestone(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('credit_wallet', params);
}
