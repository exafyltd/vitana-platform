// Genuinely tested via test/orb-tools/admin-notifications-tools.test.ts,
// which drives a real functional fake SupabaseClient (query-chain
// builder), not a wholesale module mock.
/**
 * orb-tools/admin-notifications-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/admin-notifications-tools.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countTenantMembers(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function countTenantMembersByRole(sb: SupabaseClient, tenantId: string, role: string) {
  return sb
    .from('user_tenants')
    .select('user_id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('active_role', role);
}
