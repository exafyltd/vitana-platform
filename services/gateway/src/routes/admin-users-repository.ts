// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in routes/admin-users.ts has any test coverage today — the
// only "admin-users" test matches
// (test/orb-tools/admin-users-rbac-tools.test.ts and its
// test/services/ twin) cover a different module,
// services/orb-tools/admin-users-rbac-tools.ts, not this route.
/**
 * routes/admin-users.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-users.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantAdminMembership(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_tenants').select('active_role').eq('user_id', userId).eq('tenant_id', tenantId).single();
}

export async function fetchAllTenants(sb: SupabaseClient) {
  return sb.from('tenants').select('*');
}

export async function fetchTenantMemberUserIds(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId);
}

export async function fetchUsersPage(
  sb: SupabaseClient,
  filters: { query: string; scopedUserIds: string[] | null; offset: number; limit: number },
) {
  let query = sb
    .from('app_users')
    .select('*')
    .order('created_at', { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (filters.query) query = query.ilike('email', `%${filters.query}%`);
  if (filters.scopedUserIds) query = query.in('user_id', filters.scopedUserIds);
  return query;
}

/** GET / list's memberships fan-out — full row, conditionally scoped to one tenant. */
export async function fetchMembershipsFull(sb: SupabaseClient, scopedTenantId: string | null) {
  let query = sb.from('user_tenants').select('*');
  if (scopedTenantId) query = query.eq('tenant_id', scopedTenantId);
  return query;
}

/** GET /roles-summary's memberships fan-out — active_role only, conditionally scoped to one tenant. */
export async function fetchMembershipRoles(sb: SupabaseClient, scopedTenantId: string | null) {
  let query = sb.from('user_tenants').select('active_role');
  if (scopedTenantId) query = query.eq('tenant_id', scopedTenantId);
  return query;
}

export async function fetchTenantMembershipCheck(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('user_id', userId).eq('tenant_id', tenantId).single();
}

export async function fetchUserMemberships(sb: SupabaseClient, userId: string, scopedTenantId: string | null) {
  let query = sb.from('user_tenants').select('*').eq('user_id', userId);
  if (scopedTenantId) query = query.eq('tenant_id', scopedTenantId);
  return query;
}

export async function fetchUserById(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('*').eq('user_id', userId).single();
}
