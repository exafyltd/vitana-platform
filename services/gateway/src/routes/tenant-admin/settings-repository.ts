// Coverage note: test/routes/tenant-admin/settings.test.ts exercises
// this route against a mocked '../../../lib/supabase' client (a
// functional fake, not a wholesale mock of this repository module), so
// these wrappers get genuine coverage, not a documented zero.
/**
 * routes/tenant-admin/settings.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in tenant-admin/settings.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same upsert options, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantSettings(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_settings').select('*').eq('tenant_id', tenantId).single();
}

export async function upsertTenantSettings(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('tenant_settings').upsert(row, { onConflict: 'tenant_id' }).select('*').single();
}

/**
 * VTID-05150: merge feature_flags in one SQL statement
 * (tenant_settings_merge_feature_flags, migration 20261014000400): the
 * client's top-level keys replace the stored ones, other stored keys stay, and
 * the governed `jev` key is kept unless `allowGoverned` (exafy_admin).
 */
export async function mergeTenantFeatureFlags(
  sb: SupabaseClient,
  tenantId: string,
  flags: Record<string, unknown>,
  allowGoverned: boolean,
  updatedBy: string,
) {
  return sb.rpc('tenant_settings_merge_feature_flags', {
    p_tenant_id: tenantId,
    p_flags: flags,
    p_allow_governed: allowGoverned,
    p_updated_by: updatedBy,
  });
}
