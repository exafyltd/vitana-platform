// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/users-lifecycle.ts — zero
// coverage today.
/**
 * services/admin-scanners/users-lifecycle.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/users-lifecycle.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchInvitationsExpiringSoon(sb: SupabaseClient, tenantId: string, nowIso: string, in48hIso: string) {
  return sb
    .from('tenant_invitations')
    .select('id, email, expires_at')
    .eq('tenant_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .gte('expires_at', nowIso)
    .lte('expires_at', in48hIso)
    .order('expires_at', { ascending: true })
    .limit(10);
}

export async function countInvitationsAging(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb
    .from('tenant_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .lt('created_at', sinceIso);
}

export async function countUserTenantsSince(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb.from('user_tenants').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', sinceIso);
}

export async function countUserTenantsBetween(sb: SupabaseClient, tenantId: string, sinceIso: string, untilIso: string) {
  return sb
    .from('user_tenants')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso);
}

export async function fetchRecentTenantMembers(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb.from('user_tenants').select('user_id, created_at').eq('tenant_id', tenantId).gte('created_at', sinceIso).limit(100);
}

export async function fetchAppUsersEmailVerification(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, email_verified_at').in('user_id', userIds);
}
