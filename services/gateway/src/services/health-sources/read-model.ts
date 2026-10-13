/**
 * VTID-05161 (Health Hub Phase 1 / B1) — B Change 4: the read switch.
 *
 * Behind HEALTH_SOURCES_READ (exact 'true', never on staging). When on,
 * GET /api/v1/integrations, GET /api/v1/wearables/connections and the
 * connected flags of GET /api/v1/wearables/providers take each connection's
 * STATE (status / is_active, connected_at, disconnected_at, last_sync_at) from
 * health_sources. Display fields the source model does not carry (display
 * name, provider username, the free-text last_error, integration metadata)
 * still come from the linked legacy row, so the response shape stays
 * byte-identical (contract test). Writes keep going to both models until a
 * later decommission plan.
 *
 * Fail safe: when health_sources is absent (STORE_PENDING), unreachable, or a
 * legacy row has no linked source, the route keeps its legacy answer (logged
 * with a code). The switch is turned on only after 7 clean reconciler days
 * (Change 5), so a fallback is a signal, never the normal path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isHealthSourcesStoreMissing, type HealthSourceStatus } from './health-sources';
import * as repo from './health-sources-repository';

export function isHealthSourcesReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEALTH_SOURCES_READ === 'true' && env.VITANA_ENV !== 'staging';
}

export type ReadFallbackCode = 'STORE_PENDING' | 'STORE_UNAVAILABLE' | 'LEGACY_READ_FAILED' | 'LEGACY_UNLINKED' | 'READ_THREW';
export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; code: ReadFallbackCode };

interface LinkedState {
  legacy_user_connection_id: string | null;
  legacy_user_integration_id: string | null;
  status: HealthSourceStatus;
  last_sync_at: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
}

async function linkedStates(
  sb: SupabaseClient,
  userId: string,
): Promise<{ ok: true; byConnection: Map<string, LinkedState>; byIntegration: Map<string, LinkedState> } | { ok: false; code: ReadFallbackCode }> {
  const { data, error } = await repo.fetchLinkedSourcesForUser(sb, userId);
  if (error) return { ok: false, code: isHealthSourcesStoreMissing(error) ? 'STORE_PENDING' : 'STORE_UNAVAILABLE' };
  const byConnection = new Map<string, LinkedState>();
  const byIntegration = new Map<string, LinkedState>();
  for (const s of (data ?? []) as LinkedState[]) {
    if (s.legacy_user_connection_id) byConnection.set(s.legacy_user_connection_id, s);
    if (s.legacy_user_integration_id) byIntegration.set(s.legacy_user_integration_id, s);
  }
  return { ok: true, byConnection, byIntegration };
}

/** Drop `id` while keeping every other key in the legacy select's order. */
function withoutId<T extends { id: string }>(row: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = row;
  return rest;
}

export function logReadFallback(endpoint: string, code: ReadFallbackCode): void {
  console.warn(JSON.stringify({ event: 'health_sources_read_fallback', vtid: 'VTID-05161', endpoint, code }));
}

type FullConnectionRow = {
  id: string;
  connector_id: string;
  category: string;
  display_name: string | null;
  provider_username: string | null;
  is_active: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
};

/** GET /wearables/connections rows, state from health_sources. */
export async function readWearableConnectionsFromSources(
  sb: SupabaseClient,
  userId: string,
): Promise<ReadResult<Omit<FullConnectionRow, 'id'>>> {
  try {
    const states = await linkedStates(sb, userId);
    if (!states.ok) return states;
    const { data, error } = await repo.fetchUserWearableConnectionsFullWithId(sb, userId);
    if (error) return { ok: false, code: 'LEGACY_READ_FAILED' };
    const rows: Array<Omit<FullConnectionRow, 'id'>> = [];
    for (const legacy of (data ?? []) as FullConnectionRow[]) {
      const s = states.byConnection.get(legacy.id);
      if (!s) return { ok: false, code: 'LEGACY_UNLINKED' };
      rows.push(
        withoutId({
          ...legacy,
          is_active: s.status === 'connected',
          last_sync_at: s.last_sync_at,
          connected_at: s.connected_at,
          disconnected_at: s.disconnected_at,
        }),
      );
    }
    return { ok: true, rows };
  } catch {
    return { ok: false, code: 'READ_THREW' };
  }
}

type ProviderConnectionRow = { id: string; connector_id: string; is_active: boolean; last_sync_at: string | null; display_name: string | null };

/** GET /wearables/providers user connections, connected flag from health_sources. */
export async function readProviderConnectionsFromSources(
  sb: SupabaseClient,
  userId: string,
): Promise<ReadResult<Omit<ProviderConnectionRow, 'id'>>> {
  try {
    const states = await linkedStates(sb, userId);
    if (!states.ok) return states;
    const { data, error } = await repo.fetchUserWearableConnectionsWithId(sb, userId);
    if (error) return { ok: false, code: 'LEGACY_READ_FAILED' };
    const rows: Array<Omit<ProviderConnectionRow, 'id'>> = [];
    for (const legacy of (data ?? []) as ProviderConnectionRow[]) {
      const s = states.byConnection.get(legacy.id);
      if (!s) return { ok: false, code: 'LEGACY_UNLINKED' };
      rows.push(withoutId({ ...legacy, is_active: s.status === 'connected', last_sync_at: s.last_sync_at }));
    }
    return { ok: true, rows };
  } catch {
    return { ok: false, code: 'READ_THREW' };
  }
}

type IntegrationRow = {
  id: string;
  integration_id: string;
  status: string;
  connected_at: string | null;
  disconnected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  metadata: unknown;
};

/** S6 status -> the user_integrations vocabulary (which has no `paused`). */
function integrationStatus(status: HealthSourceStatus): string {
  return status === 'paused' ? 'disconnected' : status;
}

/** GET /integrations rows, state from health_sources. */
export async function readUserIntegrationsFromSources(
  sb: SupabaseClient,
  userId: string,
): Promise<ReadResult<Omit<IntegrationRow, 'id'>>> {
  try {
    const states = await linkedStates(sb, userId);
    if (!states.ok) return states;
    const { data, error } = await repo.fetchUserIntegrationsWithId(sb, userId);
    if (error) return { ok: false, code: 'LEGACY_READ_FAILED' };
    const rows: Array<Omit<IntegrationRow, 'id'>> = [];
    for (const legacy of (data ?? []) as IntegrationRow[]) {
      const s = states.byIntegration.get(legacy.id);
      if (!s) return { ok: false, code: 'LEGACY_UNLINKED' };
      rows.push(
        withoutId({
          ...legacy,
          status: integrationStatus(s.status),
          connected_at: s.connected_at,
          disconnected_at: s.disconnected_at,
          last_sync_at: s.last_sync_at,
        }),
      );
    }
    return { ok: true, rows };
  } catch {
    return { ok: false, code: 'READ_THREW' };
  }
}
