// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/admin-tenants.ts's existing test suite (test/routes/admin-tenants.test.ts),
// which covers every call site here.
/**
 * routes/admin-tenants.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-tenants.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== tenants ====================

export async function fetchTenantsList(sb: SupabaseClient, query?: string) {
  let q = sb.from('tenants').select('*').order('name', { ascending: true });
  if (query) q = q.ilike('name', `%${query}%`);
  return q;
}

export async function fetchTenantById(sb: SupabaseClient, id: string) {
  return sb.from('tenants').select('*').eq('tenant_id', id).single();
}

export async function fetchTenantBySlug(sb: SupabaseClient, slug: string) {
  return sb.from('tenants').select('*').eq('slug', slug).single();
}

// ==================== user_tenants ====================

export async function fetchAllTenantMemberships(sb: SupabaseClient) {
  return sb.from('user_tenants').select('tenant_id');
}

export async function fetchTenantMemberships(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('*').eq('tenant_id', tenantId);
}

// ==================== app_users ====================

export async function fetchAppUsersByIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, email, display_name').in('user_id', userIds);
}
