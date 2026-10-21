// Coverage note: test/vtid-05149-tenant-context.test.ts exercises these
// wrappers through tenant-context.ts against a per-table thenable query-chain
// fake (mocks '../lib/supabase', not this module).
/**
 * services/tenancy/tenant-context.ts — data-access seam (the B1 repository
 * pattern, VTID-03702). Client-agnostic: takes `sb` as a param.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * VTID-05149: the user's primary membership, deterministic even when the data
 * is not: primary first, then the oldest membership, then tenant_id. Zero or
 * two-plus primary rows no longer turn into "no tenant" (the old `.single()`).
 */
export async function fetchPrimaryMembership(sb: SupabaseClient, userId: string, signal?: AbortSignal) {
  let query = sb
    .from('user_tenants')
    .select('tenant_id, active_role, is_primary')
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .order('tenant_id', { ascending: true })
    .limit(1);
  if (signal) query = query.abortSignal(signal);
  return query;
}

/** VTID-05149: every tenant's identity flags (2 rows today); cached by the caller. */
export async function fetchTenantFlags(sb: SupabaseClient, signal?: AbortSignal) {
  let query = sb.from('tenants').select('tenant_id, slug, is_default, is_platform');
  if (signal) query = query.abortSignal(signal);
  return query;
}
