/**
 * VTID-05161 (Health Hub Phase 1 / B1) — B Change 3: dual-write of the legacy
 * connection models into health_sources.
 *
 * Behind HEALTH_SOURCES_DUAL_WRITE (exact 'true', and never on staging: staging
 * shares the production database — the D6a flag pattern). Flag off or staging:
 * nothing is read or written, and the call sites behave exactly as before.
 *
 * After each legacy write (wearables connect / callback / disconnect, the
 * webhook auth topics, integrations connect / disconnect, and the manual-entry
 * upserts of the manual-log route, the voice log tool and the ORB health
 * tools), the call site schedules a mirror. The mirror re-reads the legacy row
 * the write produced and upserts the matching health_sources row, keyed by the
 * legacy id (legacy_user_connection_id / legacy_user_integration_id), with the
 * SAME mapping the migration's backfill uses
 * (20261014100200_vtid_05161_health_sources.sql §1d). Re-reading the legacy row
 * instead of re-stating the write means a mirror can never disagree with what
 * the legacy model actually holds, and replaying it is harmless.
 *
 * It never changes the legacy response: it is scheduled after the legacy write
 * and not awaited by the route, never throws, and a failure is logged with a
 * code, counted, and emitted as OASIS `health.sources.dual_write_failed`
 * (site + code only, no member id, no health data). While health_sources is
 * absent (Aurora-only, not applied) every mirror answers STORE_PENDING; that is
 * counted like any failure, and the OASIS event is rate-limited per site+code.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { emitOasisEvent } from '../oasis-event-service';
import { fetchPrimaryMembership } from '../tenancy/tenant-context-repository';
import { isHealthSourcesStoreMissing, type HealthSourceKind, type HealthSourceStatus } from './health-sources';
import * as repo from './health-sources-repository';

export const VTID = 'VTID-05161';

export function isHealthSourcesDualWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEALTH_SOURCES_DUAL_WRITE === 'true' && env.VITANA_ENV !== 'staging';
}

export type MirrorFailureCode =
  | 'STORE_PENDING'
  | 'STORE_UNAVAILABLE'
  | 'LEGACY_READ_FAILED'
  | 'LEGACY_ROW_MISSING'
  | 'NO_TENANT'
  | 'UNMAPPED_INTEGRATION'
  | 'IDENTITY_CONFLICT'
  | 'CONNECTOR_NOT_REGISTERED'
  | 'MIRROR_THREW';

export type MirrorResult = { ok: true; mirrored: number } | { ok: false; code: MirrorFailureCode };

export type MirrorSite =
  | 'wearables.connect'
  | 'wearables.callback'
  | 'wearables.disconnect'
  | 'webhook.auth_completed'
  | 'webhook.auth_revoked'
  | 'integrations.connect'
  | 'integrations.disconnect'
  | 'integrations.manual_log'
  | 'voice.health_log'
  | 'orb.health_depth';

// ---- the mapping (same rules as the migration's §1d) ----------------------

export interface LegacyConnectionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  connector_id: string;
  category: string;
  provider_user_id: string | null;
  is_active: boolean;
  connected_at: string | null;
  disconnected_at: string | null;
  last_sync_at: string | null;
  sync_cursor: Record<string, unknown> | null;
}

export function connectionStatus(isActive: boolean, disconnectedAt: string | null): HealthSourceStatus {
  if (isActive) return 'connected';
  return disconnectedAt ? 'disconnected' : 'pending';
}

/** user_connections row -> health_sources row, or null for a non-health category. */
export function mapLegacyConnection(row: LegacyConnectionRow): Record<string, unknown> | null {
  const kind: HealthSourceKind | null =
    row.category === 'wearable' ? 'device_cloud' : row.category === 'aggregator' ? 'aggregator' : null;
  if (!kind) return null;
  return {
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    kind,
    connector_id: row.connector_id,
    provider_user_id: row.provider_user_id ?? null,
    status: connectionStatus(row.is_active === true, row.disconnected_at ?? null),
    token_ref: `user_connections:${row.id}`,
    sync_cursor: row.sync_cursor ?? {},
    last_sync_at: row.last_sync_at ?? null,
    connected_at: row.connected_at ?? null,
    disconnected_at: row.disconnected_at ?? null,
    legacy_user_connection_id: row.id,
  };
}

export interface LegacyIntegrationRow {
  id: string;
  user_id: string;
  integration_id: string;
  status: string;
  connected_at: string | null;
  disconnected_at: string | null;
  last_sync_at: string | null;
}

/**
 * user_integrations row -> health_sources row. `connectorCategory` is the
 * connector_registry category of integration_id (null when not registered).
 * 'manual-entry' is the member's manual source; a registered wearable /
 * aggregator id maps to that connector; anything else is unmapped.
 */
export function mapLegacyIntegration(
  row: LegacyIntegrationRow,
  tenantId: string,
  connectorCategory: string | null,
): Record<string, unknown> | null {
  let kind: HealthSourceKind;
  let connectorId: string | null;
  if (row.integration_id === 'manual-entry') {
    kind = 'manual';
    connectorId = null;
  } else if (connectorCategory === 'wearable' || connectorCategory === 'aggregator') {
    kind = connectorCategory === 'wearable' ? 'device_cloud' : 'aggregator';
    connectorId = row.integration_id;
  } else {
    return null;
  }
  return {
    tenant_id: tenantId,
    user_id: row.user_id,
    kind,
    connector_id: connectorId,
    provider_user_id: null,
    status: row.status,
    last_sync_at: row.last_sync_at ?? null,
    connected_at: row.connected_at ?? null,
    disconnected_at: row.disconnected_at ?? null,
    legacy_user_integration_id: row.id,
  };
}

// ---- mirrors ----------------------------------------------------------------

function storeCode(error: unknown): MirrorFailureCode {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === '23505') return 'IDENTITY_CONFLICT';
  if (code === '23503') return 'CONNECTOR_NOT_REGISTERED';
  return isHealthSourcesStoreMissing(error) ? 'STORE_PENDING' : 'STORE_UNAVAILABLE';
}

/** Upsert one mapped row by its legacy key. Tenant and kind are fixed at first insert. */
async function upsertByLegacyKey(
  sb: SupabaseClient,
  mapped: Record<string, unknown>,
  legacy: { column: 'legacy_user_connection_id' | 'legacy_user_integration_id'; id: string },
): Promise<MirrorResult> {
  const existing =
    legacy.column === 'legacy_user_connection_id'
      ? await repo.fetchSourceIdByLegacyConnection(sb, legacy.id)
      : await repo.fetchSourceIdByLegacyIntegration(sb, legacy.id);
  if (existing.error) return { ok: false, code: storeCode(existing.error) };
  if (existing.data) {
    const { tenant_id: _t, user_id: _u, kind: _k, [legacy.column]: _l, ...patch } = mapped;
    const { error } = await repo.updateSourceById(sb, (existing.data as { id: string }).id, patch);
    return error ? { ok: false, code: storeCode(error) } : { ok: true, mirrored: 1 };
  }
  const { error } = await repo.insertSourcePlain(sb, mapped);
  return error ? { ok: false, code: storeCode(error) } : { ok: true, mirrored: 1 };
}

/** Mirror every user_connections row of (user, connector) — health categories only. */
export async function mirrorUserConnections(
  sb: SupabaseClient,
  args: { user_id: string; connector_id: string },
): Promise<MirrorResult> {
  try {
    const { data, error } = await repo.fetchLegacyConnectionsForConnector(sb, args.user_id, args.connector_id);
    if (error) return { ok: false, code: 'LEGACY_READ_FAILED' };
    let mirrored = 0;
    for (const row of (data ?? []) as LegacyConnectionRow[]) {
      const mapped = mapLegacyConnection(row);
      if (!mapped) continue; // not a health connection (social, AI assistant, …)
      const r = await upsertByLegacyKey(sb, mapped, { column: 'legacy_user_connection_id', id: row.id });
      if (!r.ok) return r;
      mirrored += r.mirrored;
    }
    return { ok: true, mirrored };
  } catch {
    return { ok: false, code: 'MIRROR_THREW' };
  }
}

/** Mirror the user_integrations row of (user, integration_id). */
export async function mirrorUserIntegration(
  sb: SupabaseClient,
  args: { user_id: string; integration_id: string; tenant_id?: string | null },
): Promise<MirrorResult> {
  try {
    const legacy = await repo.fetchLegacyIntegration(sb, args.user_id, args.integration_id);
    if (legacy.error) return { ok: false, code: 'LEGACY_READ_FAILED' };
    if (!legacy.data) return { ok: false, code: 'LEGACY_ROW_MISSING' };
    const row = legacy.data as LegacyIntegrationRow;

    let category: string | null = null;
    if (row.integration_id !== 'manual-entry') {
      const reg = await repo.fetchHealthConnector(sb, row.integration_id);
      if (reg.error) return { ok: false, code: 'LEGACY_READ_FAILED' };
      category = (reg.data as { category?: string } | null)?.category ?? null;
      if (category !== 'wearable' && category !== 'aggregator') return { ok: false, code: 'UNMAPPED_INTEGRATION' };
    }

    // user_integrations has no tenant_id: the member's primary membership, as
    // the backfill and the VTID-05149 resolver order it.
    let tenantId = args.tenant_id ?? null;
    if (!tenantId) {
      const m = await fetchPrimaryMembership(sb, row.user_id);
      if (m.error) return { ok: false, code: 'LEGACY_READ_FAILED' };
      tenantId = ((m.data as Array<{ tenant_id: string }> | null) ?? [])[0]?.tenant_id ?? null;
    }
    if (!tenantId) return { ok: false, code: 'NO_TENANT' };

    const mapped = mapLegacyIntegration(row, tenantId, category);
    if (!mapped) return { ok: false, code: 'UNMAPPED_INTEGRATION' };
    return await upsertByLegacyKey(sb, mapped, { column: 'legacy_user_integration_id', id: row.id });
  } catch {
    return { ok: false, code: 'MIRROR_THREW' };
  }
}

// ---- outcome accounting -----------------------------------------------------

const OASIS_INTERVAL_MS = 60_000;
const failureCounts = new Map<string, number>();
const lastEmit = new Map<string, { at: number; pending: number }>();

/** Per site+code failure counts since process start (tests, diagnostics). */
export function getHealthSourcesDualWriteCounters(): Record<string, number> {
  return Object.fromEntries(failureCounts);
}

export function resetHealthSourcesDualWriteCounters(): void {
  failureCounts.clear();
  lastEmit.clear();
}

async function recordOutcome(site: MirrorSite, result: MirrorResult, now: number): Promise<void> {
  if (result.ok) return;
  const key = `${site}:${result.code}`;
  failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
  console.warn(JSON.stringify({ event: 'health_sources_dual_write_failed', vtid: VTID, site, code: result.code }));
  const last = lastEmit.get(key);
  if (last && now - last.at < OASIS_INTERVAL_MS) {
    last.pending += 1;
    return;
  }
  const suppressed = last?.pending ?? 0;
  lastEmit.set(key, { at: now, pending: 0 });
  await emitOasisEvent({
    vtid: VTID,
    type: 'health.sources.dual_write_failed',
    source: 'gateway',
    status: 'warning',
    message: `health_sources dual-write failed at ${site}: ${result.code}`,
    payload: { site, code: result.code, suppressed_since_last: suppressed },
  }).catch(() => {});
}

/**
 * Schedule a mirror after a legacy write. Returns null (and does nothing)
 * when the flag is off or on staging; otherwise the settled promise, which
 * callers do not await (tests do). Never rejects.
 */
export function dualWriteUserConnections(
  sb: SupabaseClient | null | undefined,
  args: { user_id: string; connector_id: string },
  site: MirrorSite,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MirrorResult> | null {
  if (!sb || !isHealthSourcesDualWriteEnabled(env)) return null;
  return settle(site, () => mirrorUserConnections(sb, args));
}

export function dualWriteUserIntegration(
  sb: SupabaseClient | null | undefined,
  args: { user_id: string; integration_id: string; tenant_id?: string | null },
  site: MirrorSite,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MirrorResult> | null {
  if (!sb || !isHealthSourcesDualWriteEnabled(env)) return null;
  return settle(site, () => mirrorUserIntegration(sb, args));
}

function settle(site: MirrorSite, run: () => Promise<MirrorResult>): Promise<MirrorResult> {
  return Promise.resolve()
    .then(run)
    .catch((): MirrorResult => ({ ok: false, code: 'MIRROR_THREW' }))
    .then(async (result) => {
      await recordOutcome(site, result, Date.now()).catch(() => {});
      return result;
    });
}
