// Coverage note: test/vtid-05161-health-sources.test.ts runs these wrappers
// through health-sources.ts, legacy-mirror.ts, read-model.ts and reconcile.ts
// against an in-memory query-chain fake.
/**
 * VTID-05161 (Health Hub Phase 1 / B1) — data-access seam for health_sources
 * and the two legacy connection models it is built from (the B1 repository
 * pattern, VTID-03702). Client-agnostic: takes `sb` as a param. Thin query
 * wrappers only; every decision lives in the callers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const HEALTH_SOURCE_COLUMNS =
  'id, tenant_id, user_id, kind, connector_id, provider_user_id, status, last_sync_at, last_error_code, connected_at, disconnected_at, legacy_user_connection_id, legacy_user_integration_id, created_at';

// ---- health_sources -------------------------------------------------------

export function fetchSourceById(sb: SupabaseClient, tenantId: string, userId: string, sourceId: string) {
  return sb
    .from('health_sources')
    .select(HEALTH_SOURCE_COLUMNS)
    .eq('id', sourceId)
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
}

export function fetchSourceByIdentity(
  sb: SupabaseClient,
  key: { tenant_id: string; user_id: string; kind: string; connector_id: string | null; provider_user_id: string | null },
) {
  let q = sb
    .from('health_sources')
    .select(HEALTH_SOURCE_COLUMNS)
    .eq('tenant_id', key.tenant_id)
    .eq('user_id', key.user_id)
    .eq('kind', key.kind);
  q = key.connector_id === null ? q.is('connector_id', null) : q.eq('connector_id', key.connector_id);
  q = key.provider_user_id === null ? q.is('provider_user_id', null) : q.eq('provider_user_id', key.provider_user_id);
  return q.maybeSingle();
}

export function insertSource(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('health_sources').insert(row).select(HEALTH_SOURCE_COLUMNS).single();
}

export function updateSourceState(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  sourceId: string,
  patch: Record<string, unknown>,
) {
  return sb
    .from('health_sources')
    .update(patch)
    .eq('id', sourceId)
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .select('id');
}

export function listSourcesForMember(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('health_sources')
    .select(HEALTH_SOURCE_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
}

/** Read switch: every source of a member (all tenants, like the legacy reads). */
export function fetchLinkedSourcesForUser(sb: SupabaseClient, userId: string) {
  return sb
    .from('health_sources')
    .select('legacy_user_connection_id, legacy_user_integration_id, status, last_sync_at, connected_at, disconnected_at')
    .eq('user_id', userId);
}

export function fetchSourceIdByLegacyConnection(sb: SupabaseClient, legacyId: string) {
  return sb.from('health_sources').select('id').eq('legacy_user_connection_id', legacyId).maybeSingle();
}

export function fetchSourceIdByLegacyIntegration(sb: SupabaseClient, legacyId: string) {
  return sb.from('health_sources').select('id').eq('legacy_user_integration_id', legacyId).maybeSingle();
}

export function updateSourceById(sb: SupabaseClient, sourceId: string, patch: Record<string, unknown>) {
  return sb.from('health_sources').update(patch).eq('id', sourceId);
}

export function insertSourcePlain(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('health_sources').insert(row);
}

export function rpcReconcileCounts(sb: SupabaseClient) {
  return sb.rpc('health_sources_reconcile_counts');
}

// ---- legacy models (read only) --------------------------------------------

export function fetchLegacyConnectionsForConnector(sb: SupabaseClient, userId: string, connectorId: string) {
  return sb
    .from('user_connections')
    .select('id, tenant_id, user_id, connector_id, category, provider_user_id, is_active, connected_at, disconnected_at, last_sync_at, sync_cursor')
    .eq('user_id', userId)
    .eq('connector_id', connectorId);
}

export function fetchLegacyIntegration(sb: SupabaseClient, userId: string, integrationId: string) {
  return sb
    .from('user_integrations')
    .select('id, user_id, integration_id, status, connected_at, disconnected_at, last_sync_at')
    .eq('user_id', userId)
    .eq('integration_id', integrationId)
    .maybeSingle();
}

export function fetchHealthConnector(sb: SupabaseClient, connectorId: string) {
  return sb.from('connector_registry').select('id, category').eq('id', connectorId).maybeSingle();
}

/** Read switch twin of wearables-repository.fetchUserWearableConnectionsFull, plus `id` to link. */
export function fetchUserWearableConnectionsFullWithId(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_connections')
    .select('id, connector_id, category, display_name, provider_username, is_active, last_sync_at, last_error, connected_at, disconnected_at')
    .eq('user_id', userId)
    .in('category', ['wearable', 'aggregator'])
    .order('connected_at', { ascending: false });
}

/** Read switch twin of wearables-repository.fetchUserWearableConnections, plus `id` to link. */
export function fetchUserWearableConnectionsWithId(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_connections')
    .select('id, connector_id, is_active, last_sync_at, display_name')
    .eq('user_id', userId)
    .in('category', ['wearable', 'aggregator']);
}

/** Read switch twin of integrations-repository.fetchUserIntegrations, plus `id` to link. */
export function fetchUserIntegrationsWithId(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_integrations')
    .select('id, integration_id, status, connected_at, disconnected_at, last_sync_at, last_error, metadata')
    .eq('user_id', userId)
    .order('integration_id', { ascending: true });
}
