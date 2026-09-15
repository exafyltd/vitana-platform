// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// both test/services/admin-awareness-worker.test.ts and
// test/routes/tenant-admin/health-index.test.ts wholesale jest.mock
// admin-health-index.ts itself — zero genuine coverage today.
/**
 * services/admin-health-index.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in admin-health-index.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HealthComponents } from './admin-health-index';

export async function countOpenUrgentInsights(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('admin_insights')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .eq('severity', 'urgent');
}

export async function countOpenActionNeededInsights(sb: SupabaseClient, tenantId: string) {
  return sb
    .from('admin_insights')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .eq('severity', 'action_needed');
}

export async function fetchTenantKpiCurrent(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_kpi_current').select('kpi').eq('tenant_id', tenantId).maybeSingle();
}

export async function fetchPreviousHealthIndexSnapshot(sb: SupabaseClient, tenantId: string, beforeDate: string) {
  return sb
    .from('tenant_health_index_daily')
    .select('score, snapshot_date')
    .eq('tenant_id', tenantId)
    .lt('snapshot_date', beforeDate)
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function upsertTenantHealthIndexDaily(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    snapshot_date: string;
    score: number;
    components: HealthComponents;
    computed_at: string;
    source_version: string;
  },
) {
  return sb.from('tenant_health_index_daily').upsert(row, { onConflict: 'tenant_id,snapshot_date' });
}
