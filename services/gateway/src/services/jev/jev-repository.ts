/**
 * VTID-04754: every Supabase call the Jev module makes, in one seam
 * (same pattern as the *-repository.ts files elsewhere in the gateway).
 * Client-agnostic: takes `sb` as a parameter. Service role only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPrimaryTenant(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).maybeSingle();
}

export async function fetchTenantActiveRole(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_tenants').select('active_role').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle();
}

export async function fetchLatestRolePreference(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('role_preferences')
    .select('role, updated_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchExplicitRoleGrants(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_permitted_roles').select('role').eq('user_id', userId).eq('tenant_id', tenantId);
}

export async function fetchActiveMembershipRoles(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('memberships').select('role').eq('user_id', userId).eq('tenant_id', tenantId).eq('status', 'active');
}

/** Accepts a tenant uuid or slug. */
export async function fetchTenantByIdOrSlug(sb: SupabaseClient, idOrSlug: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  return sb.from('tenants').select('tenant_id, slug').eq(isUuid ? 'tenant_id' : 'slug', idOrSlug).maybeSingle();
}

export async function fetchTenantFeatureFlags(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_settings').select('feature_flags').eq('tenant_id', tenantId).maybeSingle();
}

export async function fetchTenantMonthSpend(sb: SupabaseClient, tenantId: string, month: string) {
  return sb.from('jev_spend_counters').select('cost_usd').eq('tenant_id', tenantId).eq('month', month);
}

export async function fetchMonthSpendRows(sb: SupabaseClient, month: string) {
  return sb.from('jev_spend_counters').select('tenant_id, plane, calls, input_tokens, cost_usd').eq('month', month);
}

export async function recordSpendRpc(sb: SupabaseClient, tenantId: string, plane: string, inputTokens: number, costUsd: number) {
  return sb.rpc('jev_record_spend', { p_tenant_id: tenantId, p_plane: plane, p_input_tokens: inputTokens, p_cost_usd: costUsd });
}

export async function insertShadowDecision(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('jev_shadow_decisions').insert(row).select('id').single();
}

export async function updateShadowOutcome(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('jev_shadow_decisions').update(patch).eq('id', id);
}

export async function shadowGateStatsRpc(sb: SupabaseClient, days: number) {
  return sb.rpc('jev_shadow_gate_stats', { p_days: days });
}
