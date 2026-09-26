/**
 * VTID-04674: data access for the admin notification switches. Thin wrappers
 * only — the rules live in notification-controls-service.ts and in the
 * database guard (migration 20260926190000_vtid_04674_notification_type_controls.sql).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type Sb = SupabaseClient<any, any, any>;

export function rpcTypeAllowed(sb: Sb, tenantId: string, type: string, sourceKey: string) {
  return sb.rpc('notification_type_allowed', { p_tenant: tenantId, p_type: type, p_source_key: sourceKey });
}

export function rpcMemberAllows(sb: Sb, userId: string, tenantId: string, type: string) {
  return sb.rpc('notification_member_allows', { p_user: userId, p_tenant: tenantId, p_type: type });
}

export function rpcRecordBlock(sb: Sb, tenantId: string, type: string, sourceKey: string, reason: string) {
  return sb.rpc('notification_record_block', {
    p_tenant: tenantId, p_type: type, p_source_key: sourceKey, p_reason: reason,
  });
}

export function rpcTypeStats(sb: Sb, tenantId: string, days: number) {
  return sb.rpc('notification_type_stats', { p_tenant: tenantId, p_days: days });
}

export function rpcDailyActivity(sb: Sb, tenantId: string, days: number) {
  return sb.rpc('notification_daily_activity', { p_tenant: tenantId, p_days: days });
}

export function fetchControls(sb: Sb, tenantId: string) {
  return sb
    .from('notification_type_controls')
    .select('type, source_key, enabled, auto_registered, reason, updated_by_email, created_at, updated_at')
    .eq('tenant_id', tenantId);
}

export function fetchControl(sb: Sb, tenantId: string, type: string, sourceKey: string) {
  return sb
    .from('notification_type_controls')
    .select('enabled')
    .eq('tenant_id', tenantId)
    .eq('type', type)
    .eq('source_key', sourceKey)
    .maybeSingle();
}

export function upsertControl(sb: Sb, row: Record<string, unknown>) {
  return sb.from('notification_type_controls').upsert(row, { onConflict: 'tenant_id,type,source_key' });
}

export function insertAudit(sb: Sb, row: Record<string, unknown>) {
  return sb.from('notification_type_control_audit').insert(row);
}

export function fetchAudit(sb: Sb, tenantId: string, type: string, limit: number) {
  return sb
    .from('notification_type_control_audit')
    .select('source_key, old_enabled, new_enabled, reason, actor_email, created_at')
    .eq('tenant_id', tenantId)
    .eq('type', type)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export function fetchActiveCategoriesForTenant(sb: Sb, tenantId: string) {
  return sb
    .from('notification_categories')
    .select('*')
    .eq('is_active', true)
    .or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
}

export function countTenantMembers(sb: Sb, tenantId: string, activeRole?: string) {
  let q = sb.from('user_tenants').select('user_id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if (activeRole) q = q.eq('active_role', activeRole);
  return q;
}
