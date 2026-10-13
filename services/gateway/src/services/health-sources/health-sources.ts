/**
 * VTID-05161 (Health Hub Phase 1 / B1, program VTID-05020) — S6: the one
 * connection model for every health data source.
 *
 * Shared interface S6 (plan docs/validation/VTID-05161/plan-sparring.md,
 * "Shared interfaces (Phase 1 A/B/C)", which wins over any other text):
 *   resolveHealthSource(sb, identity, { source_id } | { kind, connector_id?, provider_user_id?, create? })
 *     -> { ok:true, source_id, kind, connector_id, status }
 *      | { ok:false, code:'STORE_PENDING'|'SOURCE_NOT_CONNECTED'|'STORE_UNAVAILABLE' }
 *   setHealthSourceState(sb, identity, { source_id, status, reason_code? }) -> { ok:true } | { ok:false, code }
 *   listHealthSources(sb, identity)   (B-only)
 * None of them throws. Each answers STORE_PENDING while the table is absent
 * (health_sources is Aurora-only, so on today's Supabase that is the answer).
 *
 * - create:true is idempotent and creates only the sources nobody else owns:
 *   the member's own logging (manual / voice / diary) lazily, and phone stores
 *   on first sync. Device clouds, aggregators and partners come from their
 *   connection flows (legacy-mirror.ts), never from create:true.
 * - Phone stores (C1's caller) may pass `{ kind:'phone_store', install_id,
 *   platform }`; it is normalised to the canonical S6 form
 *   `{ kind:'phone_store', connector_id: 'apple_health'|'health_connect',
 *   provider_user_id: install_id }` before any lookup, so both shapes resolve
 *   to the same row. An unknown platform or an empty install_id answers
 *   SOURCE_NOT_CONNECTED and creates nothing.
 * - The connector_id FK to connector_registry holds for phone stores only once
 *   C1 registers apple_health / health_connect. Until then a phone-store create
 *   fails on the FK and answers STORE_UNAVAILABLE.
 * - A lookup by source_id must belong to `identity` (tenant and user).
 * - source_rank is not stored; the store derives it from kind (S2).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as repo from './health-sources-repository';

export const HEALTH_SOURCE_KINDS = ['device_cloud', 'aggregator', 'phone_store', 'partner', 'manual', 'voice', 'diary'] as const;
export type HealthSourceKind = (typeof HEALTH_SOURCE_KINDS)[number];

export const HEALTH_SOURCE_STATUSES = ['pending', 'connected', 'paused', 'disconnected', 'error'] as const;
export type HealthSourceStatus = (typeof HEALTH_SOURCE_STATUSES)[number];

/** The states a caller may set (S6); `pending` is only the start of a connection flow. */
export const SETTABLE_HEALTH_SOURCE_STATUSES = ['connected', 'paused', 'disconnected', 'error'] as const;
export type SettableHealthSourceStatus = (typeof SETTABLE_HEALTH_SOURCE_STATUSES)[number];

/** Kinds that always name a connector (DB CHECK health_sources_connector_by_kind). */
const CONNECTOR_KINDS: ReadonlySet<HealthSourceKind> = new Set(['device_cloud', 'aggregator', 'phone_store']);
/** The member's own logging: never a connector. */
const SELF_LOGGED_KINDS: ReadonlySet<HealthSourceKind> = new Set(['manual', 'voice', 'diary']);
/** Kinds create:true may create (S6). */
const CREATABLE_KINDS: ReadonlySet<HealthSourceKind> = new Set(['manual', 'voice', 'diary', 'phone_store']);

export const PHONE_STORE_CONNECTORS = { ios: 'apple_health', android: 'health_connect' } as const;
const PHONE_STORE_CONNECTOR_IDS: ReadonlySet<string> = new Set(Object.values(PHONE_STORE_CONNECTORS));

export interface HealthIdentity {
  tenant_id: string;
  user_id: string;
}

export type HealthSourcesErrorCode = 'STORE_PENDING' | 'SOURCE_NOT_CONNECTED' | 'STORE_UNAVAILABLE';

export type ResolveHealthSourceInput =
  | { source_id: string }
  | { kind: HealthSourceKind; connector_id?: string | null; provider_user_id?: string | null; create?: boolean }
  /** C1's phone-store alias, normalised to the canonical form above. */
  | { kind: 'phone_store'; install_id: string; platform: 'ios' | 'android'; create?: boolean };

export type ResolveHealthSourceResult =
  | { ok: true; source_id: string; kind: HealthSourceKind; connector_id: string | null; status: HealthSourceStatus }
  | { ok: false; code: HealthSourcesErrorCode };

export type SetHealthSourceStateResult =
  | { ok: true }
  | { ok: false; code: HealthSourcesErrorCode | 'INVALID_INPUT' };

export interface HealthSourceSummary {
  source_id: string;
  kind: HealthSourceKind;
  connector_id: string | null;
  provider_user_id: string | null;
  status: HealthSourceStatus;
  last_sync_at: string | null;
  last_error_code: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  legacy_user_connection_id: string | null;
  legacy_user_integration_id: string | null;
}

export type ListHealthSourcesResult =
  | { ok: true; sources: HealthSourceSummary[] }
  | { ok: false; code: Exclude<HealthSourcesErrorCode, 'SOURCE_NOT_CONNECTED'> };

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Table or function not there yet (Aurora-only, not applied) — the D10 isConsentStoreMissing pattern. */
export function isHealthSourcesStoreMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /relation "?[\w.]*health_sources"? does not exist|could not find the (table|function) '?public\.health_sources|schema cache.*health_sources|health_sources_reconcile_counts.*(does not exist|schema cache)/i.test(
    message,
  );
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? ((error as { code: string }).code)
    : '';
}

/** Store errors -> S6 codes. An FK miss (e.g. phone store before C1) is STORE_UNAVAILABLE. */
function storeFailure(error: unknown): { ok: false; code: 'STORE_PENDING' | 'STORE_UNAVAILABLE' } {
  return { ok: false, code: isHealthSourcesStoreMissing(error) ? 'STORE_PENDING' : 'STORE_UNAVAILABLE' };
}

function validIdentity(identity: HealthIdentity | null | undefined): identity is HealthIdentity {
  return !!identity && typeof identity.tenant_id === 'string' && identity.tenant_id.length > 0
    && typeof identity.user_id === 'string' && identity.user_id.length > 0;
}

function isKind(v: unknown): v is HealthSourceKind {
  return typeof v === 'string' && (HEALTH_SOURCE_KINDS as readonly string[]).includes(v);
}

function nonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export interface CanonicalSourceKey {
  kind: HealthSourceKind;
  connector_id: string | null;
  provider_user_id: string | null;
  create: boolean;
}

/**
 * Normalise either input shape to the canonical S6 key, or null when the
 * input cannot name a source (SOURCE_NOT_CONNECTED, nothing created).
 * Mirrors the DB CHECKs, so an invalid key never reaches the database.
 */
export function canonicalSourceKey(input: Exclude<ResolveHealthSourceInput, { source_id: string }>): CanonicalSourceKey | null {
  const raw = input as Record<string, unknown>;
  if (!isKind(raw.kind)) return null;
  const kind = raw.kind;
  const create = raw.create === true;
  let connector_id: string | null;
  let provider_user_id: string | null;
  if (kind === 'phone_store' && ('install_id' in raw || 'platform' in raw)) {
    const platform = raw.platform;
    if (platform !== 'ios' && platform !== 'android') return null;
    const install = nonEmpty(raw.install_id);
    if (!install) return null;
    connector_id = PHONE_STORE_CONNECTORS[platform];
    provider_user_id = install;
  } else {
    connector_id = nonEmpty(raw.connector_id);
    provider_user_id = nonEmpty(raw.provider_user_id);
  }
  if (CONNECTOR_KINDS.has(kind) && !connector_id) return null;
  if (SELF_LOGGED_KINDS.has(kind) && (connector_id || provider_user_id)) return null;
  if (kind === 'phone_store' && (!provider_user_id || provider_user_id.length > 256 || !PHONE_STORE_CONNECTOR_IDS.has(connector_id!))) {
    return null;
  }
  return { kind, connector_id, provider_user_id, create };
}

type SourceRow = {
  id: string;
  kind: HealthSourceKind;
  connector_id: string | null;
  provider_user_id: string | null;
  status: HealthSourceStatus;
  last_sync_at: string | null;
  last_error_code: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  legacy_user_connection_id: string | null;
  legacy_user_integration_id: string | null;
};

function resolved(row: SourceRow): ResolveHealthSourceResult {
  return { ok: true, source_id: row.id, kind: row.kind, connector_id: row.connector_id ?? null, status: row.status };
}

export async function resolveHealthSource(
  sb: SupabaseClient,
  identity: HealthIdentity,
  input: ResolveHealthSourceInput,
): Promise<ResolveHealthSourceResult> {
  try {
    if (!validIdentity(identity) || !input || typeof input !== 'object') return { ok: false, code: 'SOURCE_NOT_CONNECTED' };

    if ('source_id' in input) {
      const id = nonEmpty(input.source_id);
      if (!id) return { ok: false, code: 'SOURCE_NOT_CONNECTED' };
      const { data, error } = await repo.fetchSourceById(sb, identity.tenant_id, identity.user_id, id);
      if (error) return storeFailure(error);
      return data ? resolved(data as SourceRow) : { ok: false, code: 'SOURCE_NOT_CONNECTED' };
    }

    const key = canonicalSourceKey(input);
    if (!key) return { ok: false, code: 'SOURCE_NOT_CONNECTED' };
    const lookup = { tenant_id: identity.tenant_id, user_id: identity.user_id, kind: key.kind, connector_id: key.connector_id, provider_user_id: key.provider_user_id };

    const found = await repo.fetchSourceByIdentity(sb, lookup);
    if (found.error) return storeFailure(found.error);
    if (found.data) return resolved(found.data as SourceRow);
    if (!key.create || !CREATABLE_KINDS.has(key.kind)) return { ok: false, code: 'SOURCE_NOT_CONNECTED' };

    const now = new Date().toISOString();
    const inserted = await repo.insertSource(sb, { ...lookup, status: 'connected', connected_at: now });
    if (!inserted.error && inserted.data) return resolved(inserted.data as SourceRow);
    if (errorCode(inserted.error) === '23505') {
      // A concurrent create won the identity key: read the winner (idempotent).
      const again = await repo.fetchSourceByIdentity(sb, lookup);
      if (!again.error && again.data) return resolved(again.data as SourceRow);
      return storeFailure(again.error ?? inserted.error);
    }
    return storeFailure(inserted.error);
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

/**
 * C's Health Sync source states -> S6 (`active` -> connected,
 * `os_permission_revoked` -> paused with OS_PERMISSION_REVOKED). Null for a
 * state S6 has no mapping for.
 */
export function healthSourceStateFromSync(
  state: string,
): { status: SettableHealthSourceStatus; reason_code?: string } | null {
  if (state === 'active') return { status: 'connected' };
  if (state === 'os_permission_revoked') return { status: 'paused', reason_code: 'OS_PERMISSION_REVOKED' };
  return (SETTABLE_HEALTH_SOURCE_STATUSES as readonly string[]).includes(state)
    ? { status: state as SettableHealthSourceStatus }
    : null;
}

export async function setHealthSourceState(
  sb: SupabaseClient,
  identity: HealthIdentity,
  input: { source_id: string; status: SettableHealthSourceStatus; reason_code?: string | null },
): Promise<SetHealthSourceStateResult> {
  try {
    if (!validIdentity(identity) || !input || !nonEmpty(input.source_id)) return { ok: false, code: 'INVALID_INPUT' };
    if (!(SETTABLE_HEALTH_SOURCE_STATUSES as readonly string[]).includes(input.status)) return { ok: false, code: 'INVALID_INPUT' };
    const reason = input.reason_code ?? null;
    if (reason !== null && !REASON_CODE.test(reason)) return { ok: false, code: 'INVALID_INPUT' };

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: input.status, last_error_code: reason };
    if (input.status === 'connected') {
      patch.connected_at = now;
      patch.disconnected_at = null;
    }
    if (input.status === 'disconnected') patch.disconnected_at = now;

    const { data, error } = await repo.updateSourceState(sb, identity.tenant_id, identity.user_id, input.source_id.trim(), patch);
    if (error) return storeFailure(error);
    return Array.isArray(data) && data.length > 0 ? { ok: true } : { ok: false, code: 'SOURCE_NOT_CONNECTED' };
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

export async function listHealthSources(sb: SupabaseClient, identity: HealthIdentity): Promise<ListHealthSourcesResult> {
  try {
    if (!validIdentity(identity)) return { ok: true, sources: [] };
    const { data, error } = await repo.listSourcesForMember(sb, identity.tenant_id, identity.user_id);
    if (error) return storeFailure(error);
    const sources = ((data ?? []) as SourceRow[]).map((r) => ({
      source_id: r.id,
      kind: r.kind,
      connector_id: r.connector_id ?? null,
      provider_user_id: r.provider_user_id ?? null,
      status: r.status,
      last_sync_at: r.last_sync_at ?? null,
      last_error_code: r.last_error_code ?? null,
      connected_at: r.connected_at ?? null,
      disconnected_at: r.disconnected_at ?? null,
      legacy_user_connection_id: r.legacy_user_connection_id ?? null,
      legacy_user_integration_id: r.legacy_user_integration_id ?? null,
    }));
    return { ok: true, sources };
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}
