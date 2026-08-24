// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/integrations.ts — zero coverage today.
/**
 * routes/integrations.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic (takes
 * `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** GET / — list the authenticated user's integrations. */
export async function fetchUserIntegrations(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_integrations')
    .select('integration_id, status, connected_at, disconnected_at, last_sync_at, last_error, metadata')
    .eq('user_id', userId)
    .order('integration_id', { ascending: true });
}

/** POST /:integration_id/connect — mark an integration as connected. */
export async function upsertIntegrationConnected(sb: SupabaseClient, userId: string, integrationId: string) {
  return sb
    .from('user_integrations')
    .upsert(
      {
        user_id: userId,
        integration_id: integrationId,
        status: 'connected',
        connected_at: new Date().toISOString(),
        disconnected_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,integration_id' },
    )
    .select()
    .single();
}

/** POST /:integration_id/disconnect — mark an integration as disconnected. */
export async function upsertIntegrationDisconnected(sb: SupabaseClient, userId: string, integrationId: string) {
  return sb
    .from('user_integrations')
    .upsert(
      {
        user_id: userId,
        integration_id: integrationId,
        status: 'disconnected',
        disconnected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,integration_id' },
    )
    .select()
    .single();
}

/** POST /manual/log — resolve the user's tenant via user_tenants fallback. */
export async function fetchUserTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

/** POST /manual/log — upsert the manually-logged feature row. */
export async function upsertHealthFeatureDaily(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    date: string;
    feature_key: string;
    feature_value: number;
    feature_unit: string | null;
    sample_count: number;
    confidence: number;
  },
) {
  return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' });
}

/** POST /manual/log — mark the manual-entry integration connected + bump last_sync_at. */
export async function upsertManualEntryIntegrationSynced(sb: SupabaseClient, userId: string) {
  return sb.from('user_integrations').upsert(
    {
      user_id: userId,
      integration_id: 'manual-entry',
      status: 'connected',
      connected_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      metadata: { source: 'manual_log' },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,integration_id' },
  );
}

/** POST /manual/log — recompute the canonical Index row after a manual log. */
export async function recomputeVitanaIndexForUser(sb: SupabaseClient, userId: string, date: string) {
  return sb.rpc('health_compute_vitana_index_for_user', { p_user_id: userId, p_date: date });
}
