// impact-allow-no-test: pure data-access seam (thin Supabase RPC/query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/community.ts — zero coverage today.
/**
 * routes/community.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same queries, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param, regardless of which client instance — user-token or
 * service-role — the caller happens to hold).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function createCommunityGroupRpc(sb: SupabaseClient, payload: unknown) {
  return sb.rpc('community_create_group', { p_payload: payload });
}

/** Reused for both the direct /groups/:id/join route and the accept-invitation flow. */
export async function joinCommunityGroupRpc(sb: SupabaseClient, groupId: string) {
  return sb.rpc('community_join_group', { p_group_id: groupId });
}

export async function fetchGroupNameTenantCreator(sb: SupabaseClient, groupId: string) {
  return sb.from('community_groups').select('name, tenant_id, created_by').eq('id', groupId).single();
}

export async function fetchGroupMembersExcluding(sb: SupabaseClient, groupId: string, excludeUserId: string) {
  return sb.from('community_group_members').select('user_id').eq('group_id', groupId).neq('user_id', excludeUserId);
}

export async function fetchGroupTenantId(sb: SupabaseClient, groupId: string) {
  return sb.from('community_groups').select('tenant_id').eq('id', groupId).maybeSingle();
}

export async function fetchGlobalGroupById(sb: SupabaseClient, groupId: string) {
  return sb.from('global_community_groups').select('id, name').eq('id', groupId).maybeSingle();
}

export async function fetchGlobalGroupMembership(sb: SupabaseClient, groupId: string, userId: string) {
  return sb.from('global_community_group_members').select('id').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
}

export function insertGlobalGroupMembership(
  sb: SupabaseClient,
  groupId: string,
  userId: string,
): PromiseLike<{ error: { message?: string; code?: string } | null }> {
  return sb.from('global_community_group_members').insert({ group_id: groupId, user_id: userId, role: 'member' });
}

export async function createCommunityMeetupRpc(sb: SupabaseClient, payload: unknown) {
  return sb.rpc('community_create_meetup', { p_payload: payload });
}

export async function recomputeCommunityRecommendationsRpc(sb: SupabaseClient, date: unknown) {
  return sb.rpc('community_recompute_recommendations', { p_user_id: null, p_date: date });
}

export async function getCommunityRecommendationsRpc(sb: SupabaseClient, date: unknown, type: unknown) {
  return sb.rpc('community_get_recommendations', { p_user_id: null, p_date: date, p_type: type });
}

export async function getCommunityRecommendationExplainRpc(sb: SupabaseClient, recommendationId: string) {
  return sb.rpc('community_get_recommendation_explain', { p_recommendation_id: recommendationId });
}

export async function fetchGroupForInvite(sb: SupabaseClient, groupId: string) {
  return sb.from('community_groups').select('id, name, tenant_id').eq('id', groupId).single();
}

export async function insertGroupInvitation(
  sb: SupabaseClient,
  row: { tenant_id: string; group_id: string; invited_by: string; invited_user_id: string; message: string | null },
) {
  return sb.from('community_group_invitations').insert(row).select('id').single();
}

export async function fetchInvitationForAccept(sb: SupabaseClient, invitationId: string) {
  return sb.from('community_group_invitations').select('id, group_id, tenant_id, invited_user_id, status').eq('id', invitationId).single();
}

export async function fetchInvitationForDecline(sb: SupabaseClient, invitationId: string) {
  return sb.from('community_group_invitations').select('id, invited_user_id, status').eq('id', invitationId).single();
}

/** Reused for both accept ('accepted') and decline ('declined'). */
export function updateInvitationStatus(sb: SupabaseClient, invitationId: string, status: 'accepted' | 'declined', respondedAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('community_group_invitations').update({ status, responded_at: respondedAt }).eq('id', invitationId);
}
