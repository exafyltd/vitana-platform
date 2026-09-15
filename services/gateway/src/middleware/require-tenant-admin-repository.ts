// Genuine coverage: test/middleware/require-tenant-admin.test.ts mocks
// createClient() from @supabase/supabase-js at the module boundary
// (not this module) — a real functional fake client, not a wholesale
// mock of the code under test.
/**
 * middleware/require-tenant-admin.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in require-tenant-admin.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. This is access-control logic (tenant-admin RBAC) — the
 * gate itself, in require-tenant-admin.ts, is completely untouched;
 * only the raw query is relocated. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchCallerActiveRoleForTenant(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('user_tenants')
    .select('active_role')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();
}
