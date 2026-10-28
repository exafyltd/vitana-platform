/**
 * social-connect-service.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in social-connect-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * directory/its siblings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== social_connections ====================

export async function upsertSocialConnection(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase
    .from('social_connections')
    .upsert(row, { onConflict: 'tenant_id,user_id,provider' })
    .select('id')
    .single();
}

export async function deactivateSocialConnection(
  supabase: SupabaseClient,
  userId: string,
  provider: string,
  disconnectedAtIso: string,
) {
  return supabase
    .from('social_connections')
    .update({
      is_active: false,
      disconnected_at: disconnectedAtIso,
      access_token: null,
      refresh_token: null,
    })
    .eq('user_id', userId)
    .eq('provider', provider);
}

export async function fetchUserActiveConnections(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('social_connections')
    .select('provider, provider_username, display_name, avatar_url, profile_url, enrichment_status, connected_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('connected_at', { ascending: false });
}

export async function fetchConnectionById(supabase: SupabaseClient, connectionId: string, userId: string) {
  return supabase.from('social_connections').select('*').eq('id', connectionId).eq('user_id', userId).maybeSingle();
}

export async function updateConnectionEnrichmentStatus(
  supabase: SupabaseClient,
  connectionId: string,
  status: string,
  updatedAtIso: string,
) {
  return supabase
    .from('social_connections')
    .update({ enrichment_status: status, updated_at: updatedAtIso })
    .eq('id', connectionId);
}

export async function updateConnectionEnrichmentComplete(supabase: SupabaseClient, connectionId: string, patch: Record<string, unknown>) {
  return supabase.from('social_connections').update(patch).eq('id', connectionId);
}

export async function fetchActiveConnectionsForProviders(supabase: SupabaseClient, userId: string, providers: string[]) {
  return supabase
    .from('social_connections')
    .select('id, provider, access_token, provider_username')
    .eq('user_id', userId)
    .eq('is_active', true)
    .in('provider', providers);
}

// ==================== app_users ====================

export async function fetchAppUserProfileFields(supabase: SupabaseClient, userId: string) {
  return supabase.from('app_users').select('display_name, avatar_url, bio').eq('user_id', userId).maybeSingle();
}

export async function updateAppUserProfile(supabase: SupabaseClient, userId: string, patch: Record<string, unknown>) {
  return supabase.from('app_users').update(patch).eq('user_id', userId);
}

// ==================== memory_facts ====================

export async function upsertMemoryFactSimple(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('memory_facts').upsert(row, { onConflict: 'user_id,key' });
}

// ==================== user_topic_profile ====================

export async function upsertUserTopicProfile(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_topic_profile').upsert(row, { onConflict: 'tenant_id,user_id,topic_key' });
}

// ==================== social_share_prefs ====================

export async function fetchSharePrefs(supabase: SupabaseClient, userId: string, tenantId: string) {
  return supabase.from('social_share_prefs').select('*').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle();
}

export async function upsertSharePrefs(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('social_share_prefs').upsert(row, { onConflict: 'tenant_id,user_id' });
}

// ==================== social_share_log ====================

export async function insertShareLogEntry(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('social_share_log').insert(row).select('id').single();
}

export async function updateShareLogStatus(supabase: SupabaseClient, logId: string, patch: Record<string, unknown>) {
  return supabase.from('social_share_log').update(patch).eq('id', logId);
}
