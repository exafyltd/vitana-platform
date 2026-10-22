// Coverage note: test/vtid-05270-job-tenant-loop.test.ts exercises these
// wrappers through job-tenant-loop.ts against a per-table query-chain fake.
/**
 * services/jobs/job-tenant-loop.ts — data-access seam (the B1 repository
 * pattern, VTID-03702). Client-agnostic: takes `sb` as a param. Reads only;
 * one query each per tick.
 *
 * VTID-05270: the plan text names `tenants.id`; the live key column is
 * `tenants.tenant_id` (every other gateway read, e.g.
 * tenant-context-repository.ts:31), so that is what is selected.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Active, non-platform tenants (20261014000100: is_active / is_platform). */
export async function fetchActiveTenants(sb: SupabaseClient) {
  return sb.from('tenants').select('tenant_id').eq('is_active', true).eq('is_platform', false);
}

/**
 * Per-tenant job settings: timezone (20261014000400:44) and feature_flags
 * (20260412300000_tenant_settings.sql:12).
 */
export async function fetchTenantSettings(sb: SupabaseClient, tenantIds: string[]) {
  return sb.from('tenant_settings').select('tenant_id, timezone, feature_flags').in('tenant_id', tenantIds);
}
