// Coverage note: test/routes/tenant-admin/health-index.test.ts
// exercises this route against a mocked '../../../lib/supabase' client
// (a functional fake, not a wholesale mock of this repository module),
// so these wrappers get genuine coverage, not a documented zero.
/**
 * routes/tenant-admin/health-index.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in tenant-admin/health-index.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantHealthIndexHistory(sb: SupabaseClient, tenantId: string, startDate: string) {
  return sb
    .from('tenant_health_index_daily')
    .select('snapshot_date, score, components, computed_at, source_version')
    .eq('tenant_id', tenantId)
    .gte('snapshot_date', startDate)
    .order('snapshot_date', { ascending: false });
}

export async function fetchTenantHealthIndexCurrent(sb: SupabaseClient, tenantId: string, today: string) {
  return sb
    .from('tenant_health_index_daily')
    .select('snapshot_date, score, components, computed_at, source_version')
    .eq('tenant_id', tenantId)
    .lte('snapshot_date', today)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
}
