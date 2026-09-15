/**
 * automation-handlers/onboarding-growth.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in automation-handlers/
 * onboarding-growth.ts now goes through here instead of being written
 * inline. PURE MOVE, not a rewrite: same queries, same columns, same
 * conditional-filter logic, same return shapes — no behavior change
 * today. Client-agnostic (takes `supabase` as a param) — handlers receive
 * their client via `AutomationContext`, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== app_users ====================

export async function fetchUserBasics(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('display_name, language, created_at').eq('user_id', userId).maybeSingle();
}

export async function fetchUserAvatarUrl(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('avatar_url:profile->>avatar_url').eq('user_id', userId).maybeSingle();
}

export async function fetchUsersByEmails(supabase: SupabaseClient, emails: string[]) {
  return supabase.from('app_users').select('user_id, email').in('email', emails);
}

export async function fetchExistingEmails(supabase: SupabaseClient, emails: string[]) {
  return supabase.from('app_users').select('email').in('email', emails);
}

export async function fetchUserNameAndEmail(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('display_name, email').eq('user_id', userId).maybeSingle();
}

export async function fetchColleaguesByDomain(supabase: SupabaseClient, domain: string, excludeUserId: string) {
  return supabase.from('app_users').select('user_id').like('email', `%@${domain}`).neq('user_id', excludeUserId).limit(10);
}

export async function fetchUserCreatedAt(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('created_at').eq('user_id', userId).maybeSingle();
}

// ==================== user_interests ====================

export async function countUserInterests(supabase: SupabaseClient, userId: string) {
  return supabase.from('user_interests').select('id', { count: 'exact', head: true }).eq('user_id', userId);
}

export async function fetchTopUserInterestNames(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase.from('user_interests').select('interest').eq('user_id', userId).order('confidence_score', { ascending: false }).limit(limit);
}

// ==================== global_community_groups ====================

export async function fetchMatchedActiveGroups(supabase: SupabaseClient, categories: string[]) {
  return supabase.from('global_community_groups').select('id, name, category').eq('status', 'active').in('category', categories).limit(3);
}

// ==================== global_community_events ====================

export async function fetchUpcomingEventsInWindow(supabase: SupabaseClient, fromIso: string, toIso: string) {
  return supabase
    .from('global_community_events')
    .select('id, title, start_time')
    .gte('start_time', fromIso)
    .lte('start_time', toIso)
    .order('start_time', { ascending: true })
    .limit(3);
}

// ==================== relationship_edges ====================

export async function upsertSuggestedConnectionEdge(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('relationship_edges').upsert(row, {
    onConflict: 'tenant_id,source_type,source_id,target_type,target_id,edge_type',
  });
}

export async function fetchPriorConnectionSuggestions(supabase: SupabaseClient, tenantId: string, targetId: string) {
  return supabase
    .from('relationship_edges')
    .select('source_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('target_type', 'person')
    .eq('target_id', targetId)
    .eq('edge_type', 'suggested')
    .limit(20);
}

export async function countConnectionCount(supabase: SupabaseClient, tenantId: string, userId: string) {
  return supabase
    .from('relationship_edges')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected');
}

export async function fetchConnectedUserIds(supabase: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return supabase
    .from('relationship_edges')
    .select('target_id')
    .eq('tenant_id', tenantId)
    .eq('source_type', 'person')
    .eq('source_id', userId)
    .eq('target_type', 'person')
    .eq('edge_type', 'connected')
    .limit(limit);
}

// ==================== referrals ====================

export async function fetchReferralsForUser(supabase: SupabaseClient, tenantId: string, referredId: string) {
  return supabase.from('referrals').select('referrer_id').eq('tenant_id', tenantId).eq('referred_id', referredId);
}

// ==================== global_community_group_members ====================

export async function countGroupJoinsAmong(supabase: SupabaseClient, userIds: string[], sinceIso: string) {
  return supabase
    .from('global_community_group_members')
    .select('id', { count: 'exact', head: true })
    .in('user_id', userIds)
    .gte('joined_at', sinceIso);
}

// ==================== global_event_participants ====================

export async function countEventRsvpsAmong(supabase: SupabaseClient, userIds: string[], sinceIso: string) {
  return supabase
    .from('global_event_participants')
    .select('id', { count: 'exact', head: true })
    .in('user_id', userIds)
    .eq('status', 'attending')
    .gte('registered_at', sinceIso);
}

// ==================== sharing_links ====================

export async function insertSharingLink(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('sharing_links').insert(row);
}

// ==================== social_connections ====================

export async function countActiveSocialConnections(supabase: SupabaseClient, userId: string) {
  return supabase.from('social_connections').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_active', true);
}

export async function fetchPendingSocialConnections(supabase: SupabaseClient, limit: number) {
  return supabase.from('social_connections').select('id, user_id').eq('enrichment_status', 'pending').eq('is_active', true).limit(limit);
}

// ==================== wallet ====================

export async function creditWalletBalance(supabase: SupabaseClient, params: { p_user_id: string; p_currency_type: string; p_amount: number }) {
  return supabase.rpc('increment_wallet_balance', params);
}
