// Genuinely tested via test/routes/tenant-admin/kpis.test.ts, which
// drives a real functional fake Supabase chain, table-keyed (from(table)
// returns a per-table chain instance) — not a wholesale module mock.
/**
 * routes/tenant-admin/kpis.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in tenant-admin/kpis.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantKpiCurrent(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('tenant_kpi_current')
    .select('tenant_id, generated_at, kpi, computation_duration_ms, source_version')
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

export async function fetchTenantKpiDailyHistory(sb: SupabaseClient, tenantId: string, fromDate: string) {
  return sb
    .from('tenant_kpi_daily')
    .select('snapshot_date, kpi, computed_at')
    .eq('tenant_id', tenantId)
    .gte('snapshot_date', fromDate)
    .order('snapshot_date', { ascending: false });
}
