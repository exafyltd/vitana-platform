// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/admin-staging.ts — zero coverage today.
/**
 * routes/admin-staging.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantSettingsFeatureFlags(sb: SupabaseClient, tenantId?: string | null) {
  let query = sb.from('tenant_settings').select('tenant_id, feature_flags');
  if (tenantId && tenantId !== 'ALL') {
    query = query.eq('tenant_id', tenantId);
  }
  query = query.limit(500);
  return query;
}

export function updateTenantFeatureFlags(
  sb: SupabaseClient,
  tenantId: string,
  featureFlags: Record<string, unknown>,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('tenant_settings').update({ feature_flags: featureFlags }).eq('tenant_id', tenantId);
}

export async function fetchShadowComparedEventsInWindow(sb: SupabaseClient, sinceIso: string) {
  return sb
    .from('oasis_events')
    .select('id, created_at, metadata')
    .eq('topic', 'eval.shadow.compared')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50_000);
}

export async function fetchAppUserForWakeBrief(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('tenant_id, display_name').eq('user_id', userId).maybeSingle();
}

export async function fetchUserNameFact(sb: SupabaseClient, userId: string) {
  return sb.from('memory_facts').select('fact_value').eq('user_id', userId).eq('fact_key', 'user_name').maybeSingle();
}
