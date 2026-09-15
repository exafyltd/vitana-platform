// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/tenant-admin/overview.ts's existing test suite, which covers every
// call site here.
/**
 * routes/tenant-admin/overview.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/tenant-admin/overview.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_tenants ====================

export async function countTenantMembers(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function countTenantSignupsSince(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', sinceIso);
}

export async function countTenantSignupsInWindow(sb: SupabaseClient, tenantId: string, fromIso: string, toIso: string) {
  return sb.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', fromIso).lt('created_at', toIso);
}

export async function fetchTenantMemberRoles(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('active_role').eq('tenant_id', tenantId);
}

export async function fetchTenantMembers(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id, active_role, created_at').eq('tenant_id', tenantId);
}

// ==================== tenant_invitations ====================

export async function countPendingTenantInvitations(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('tenant_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null);
}

// ==================== kb_documents ====================

export async function countKbDocuments(sb: SupabaseClient, tenantId: string) {
  return sb.from('kb_documents').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

// ==================== app_users ====================

export async function fetchAppUsersByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, email, display_name, updated_at, avatar_url:profile->>avatar_url').in('user_id', userIds);
}

// ==================== oasis_events ====================

export async function fetchRecentOasisEvents(sb: SupabaseClient, limit: number) {
  return sb.from('oasis_events').select('*').order('created_at', { ascending: false }).limit(limit);
}

export async function fetchRecentSevereOasisEvents(sb: SupabaseClient, statuses: string[], sinceIso: string, limit: number) {
  return sb
    .from('oasis_events')
    .select('*')
    .in('status', statuses)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}
