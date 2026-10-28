/**
 * admin-awareness-worker.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in admin-awareness-worker.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * directory.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== tenants ====================

export async function fetchAllTenants(supabase: SupabaseClient) {
  return supabase.from('tenants').select('tenant_id, is_active');
}

// ==================== user_tenants ====================

export async function countTenantMembers(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function countTenantSignupsSince(supabase: SupabaseClient, tenantId: string, sinceIso: string) {
  return supabase
    .from('user_tenants')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso);
}

export async function countTenantSignupsBetween(supabase: SupabaseClient, tenantId: string, fromIso: string, toIso: string) {
  return supabase
    .from('user_tenants')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', fromIso)
    .lt('created_at', toIso);
}

// ==================== tenant_invitations ====================

export async function countPendingInvitations(supabase: SupabaseClient, tenantId: string) {
  return supabase
    .from('tenant_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null);
}

export async function countExpiringInvitations(supabase: SupabaseClient, tenantId: string, fromIso: string, toIso: string) {
  return supabase
    .from('tenant_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .lte('expires_at', toIso)
    .gte('expires_at', fromIso);
}

// ==================== global_community_events ====================

export async function countTenantEventsInWindow(supabase: SupabaseClient, tenantId: string, fromIso: string, toIso: string) {
  return supabase
    .from('global_community_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('start_time', fromIso)
    .lt('start_time', toIso);
}

// ==================== global_community_groups ====================

// No tenant_id column — global count, not per-tenant (see caller's own comment).
export async function countAllCommunityGroups(supabase: SupabaseClient) {
  return supabase.from('global_community_groups').select('id', { count: 'exact', head: true });
}

// ==================== live_rooms ====================

export async function countActiveLiveRooms(supabase: SupabaseClient, tenantId: string, nowIso: string) {
  return supabase.from('live_rooms').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('ends_at', nowIso);
}

// ==================== community_memberships ====================

export async function countNewMembershipsSince(supabase: SupabaseClient, tenantId: string, sinceIso: string) {
  return supabase
    .from('community_memberships')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso);
}

// ==================== tenant_autopilot_runs ====================

export async function countAutopilotRunsSince(supabase: SupabaseClient, tenantId: string, sinceIso: string) {
  return supabase
    .from('tenant_autopilot_runs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('started_at', sinceIso);
}

export async function countAutopilotRunsByStatusSince(supabase: SupabaseClient, tenantId: string, sinceIso: string, status: string) {
  return supabase
    .from('tenant_autopilot_runs')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('started_at', sinceIso)
    .eq('status', status);
}

// ==================== autopilot_recommendations ====================

export async function countRecommendationsByStatus(supabase: SupabaseClient, status: string) {
  return supabase.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('status', status);
}

export async function countRecommendationsByStatusSince(supabase: SupabaseClient, status: string, sinceIso: string) {
  return supabase
    .from('autopilot_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('status', status)
    .gte('updated_at', sinceIso);
}

// ==================== tenant_kpi_current / tenant_kpi_daily ====================

export async function upsertTenantKpiCurrent(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('tenant_kpi_current').upsert(row, { onConflict: 'tenant_id' });
}

export async function upsertTenantKpiDaily(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('tenant_kpi_daily').upsert(row, { onConflict: 'tenant_id,snapshot_date' });
}
