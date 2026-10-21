/**
 * VTID-05164 (Health Hub Phase 1 / C1) — the Health Sync ingest adapter.
 *
 * processHealthSyncBatch turns one validated Health Sync v1 batch (S1) into
 * the input of A's single write entry point writeHealthSamples (S3) and maps
 * A's result back to wire codes with the S3 mapping table of the shared
 * interfaces. Order:
 *
 *   1. records whose type is not in the v1 catalogue: UNSUPPORTED_TYPE, never
 *      sent to A.
 *   2. consent per category present, ONE read each (at most 4), through A2's
 *      findActiveHealthConsentId (S7, fail closed: an error is "not granted").
 *      Unconsented records are dropped HERE, before A is called, so they never
 *      reach A's store, quarantine or raw archive (CATEGORY_NOT_CONSENTED).
 *      A still checks consent itself (S3: "callers may filter first").
 *      No consented category and no deletion -> 403 CONSENT_REQUIRED, and
 *      nothing is created (the source is resolved only after this check).
 *      Deletions always pass through, whatever the consent state (S8/S9).
 *   3. source through B's resolveHealthSource (S6): a phone store is created on
 *      first sync ({kind:'phone_store', connector_id, provider_user_id:
 *      install_id, create:true}); an aggregator is looked up only (it comes
 *      from its connection flow). A paused or disconnected source answers
 *      409 SOURCE_PAUSED.
 *   4. writeHealthSamples; ok:false and per-record statuses -> wire codes.
 *
 * Never throws: every failure is an outcome. OASIS payloads carry the batch id,
 * the source kind, category names, counts and codes — never a health value
 * and never a record id. An emit failure is logged, never fails the batch.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';
import { emitOasisEvent } from '../oasis-event-service';
import {
  findActiveHealthConsentId,
  HEALTH_SYNC_CONSENT_KEYS,
  type HealthConsentCategoryKey,
  type HealthSyncCategory,
} from '../consent/health-consent';
import {
  resolveHealthSource,
  type ResolveHealthSourceInput,
  type ResolveHealthSourceResult,
} from '../health-sources/health-sources';
import {
  writeHealthSamples,
  type HealthDeletionInput,
  type HealthSampleInput,
  type WriteHealthSamplesInput,
  type WriteHealthSamplesResult,
} from '../health-store/ingest';
import {
  BATCH_ERROR_CODES,
  HEALTH_SYNC_VTID,
  parseHealthSyncBatch,
  syncCatalogueEntry,
  type BatchErrorCode,
  type HealthSyncBatchV1,
  type HealthSyncRecordV1,
  type RecordErrorCode,
} from './contract-v1';

export interface HealthSyncIdentity {
  tenant_id: string;
  user_id: string;
}

export type HealthSyncChannelOptions =
  | { channel: 'native' }
  /** Phase 2 aggregator adapters: the verified webhook names the aggregator connection. */
  | { channel: 'aggregator'; connector_id: string; provider_user_id: string };

export interface HealthSyncDeps {
  resolveSource: (identity: HealthSyncIdentity, input: ResolveHealthSourceInput) => Promise<ResolveHealthSourceResult>;
  findConsentId: (identity: HealthSyncIdentity, key: HealthConsentCategoryKey, resourceId: string) => Promise<string | null>;
  writeHealthSamples: (input: WriteHealthSamplesInput) => Promise<WriteHealthSamplesResult>;
  emit: (event: CicdOasisEvent) => Promise<unknown>;
  log: (line: Record<string, unknown>) => void;
}

export function defaultHealthSyncDeps(sb: SupabaseClient): HealthSyncDeps {
  return {
    resolveSource: (identity, input) => resolveHealthSource(sb, identity, input),
    findConsentId: (identity, key, resourceId) => findActiveHealthConsentId(sb, identity, key, resourceId),
    writeHealthSamples: (input) => writeHealthSamples(sb, input),
    emit: (event) => emitOasisEvent(event),
    log: (line) => console.log(JSON.stringify(line)),
  };
}

export type ConsentState = 'granted' | 'not_granted';

export interface HealthSyncCounts {
  stored: number;
  duplicate: number;
  updated: number;
  deleted: number;
  rejected: number;
}

export interface RejectedRecord {
  record_id: string;
  code: RecordErrorCode;
  /** Only STORE_UNAVAILABLE: re-send this record in a NEW batch. */
  retryable?: true;
}

export interface HealthSyncSuccessBody {
  ok: true;
  batch_id: string;
  replay: boolean;
  counts: HealthSyncCounts;
  rejected: RejectedRecord[];
  consent: Partial<Record<HealthSyncCategory, ConsentState>>;
  source_state: string;
}

export interface HealthSyncErrorBody {
  ok: false;
  error: BatchErrorCode;
  retryable: boolean;
  retry_after_s?: number;
  details?: unknown;
  categories?: HealthSyncCategory[];
  reason?: string;
}

export type HealthSyncOutcome =
  | { status: 200; body: HealthSyncSuccessBody }
  | { status: number; body: HealthSyncErrorBody };

export function batchError(code: BatchErrorCode, extra: Partial<HealthSyncErrorBody> = {}): { status: number; body: HealthSyncErrorBody } {
  const spec = BATCH_ERROR_CODES[code];
  return { status: spec.status, body: { ok: false, error: code, retryable: spec.retryable, ...extra } };
}

/** S3 store quarantine / status codes -> Health Sync v1 per-record codes (shared interfaces, S3 mapping). */
export function mapStoreRecordCode(status: string, code?: string): RecordErrorCode | null {
  switch (status) {
    case 'stored':
    case 'updated':
    case 'duplicate':
    case 'deleted':
    case 'not_found':
      return null;
    case 'quarantined':
      switch (code) {
        case 'IMPLAUSIBLE':
          return 'IMPLAUSIBLE_VALUE';
        case 'UNIT_MISMATCH':
          return 'UNIT_MISMATCH';
        case 'UNKNOWN_CODE':
        case 'CATEGORY_NOT_ALLOWED':
          return 'UNSUPPORTED_TYPE';
        case 'TOO_OLD':
        case 'FUTURE':
          return 'OUT_OF_WINDOW';
        default:
          return 'INVALID_RECORD'; // MISALIGNED_BUCKET and anything new
      }
    case 'invalid':
      return 'INVALID_RECORD';
    case 'skipped_no_consent':
      return 'CATEGORY_NOT_CONSENTED';
    case 'store_unavailable':
      return 'STORE_UNAVAILABLE';
    default:
      return 'STORE_UNAVAILABLE';
  }
}

/** S3 ok:false -> Health Sync v1 batch error (shared interfaces, S3 mapping). */
export function mapStoreBatchError(code: string): { status: number; body: HealthSyncErrorBody } {
  switch (code) {
    case 'STORE_DISABLED':
      return batchError('INGEST_DISABLED', { reason: 'flag_off' });
    case 'STORE_PENDING':
      return batchError('STORE_PENDING');
    case 'BATCH_ID_REUSED':
      return batchError('BATCH_ID_REUSED');
    case 'QUOTA_EXCEEDED':
      return batchError('RATE_LIMITED', { retry_after_s: 3600 });
    case 'INVALID_INPUT':
      return batchError('INVALID_BATCH');
    case 'STORE_UNAVAILABLE':
    case 'SOURCE_NOT_CONNECTED':
    default:
      return batchError('STORE_UNAVAILABLE');
  }
}

function deviceLabel(batch: HealthSyncBatchV1): string | null {
  const d = batch.source.device;
  if (!d) return null;
  const label = [d.manufacturer, d.model].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ').trim();
  return label.length > 0 ? label.slice(0, 256) : null;
}

function toSample(r: HealthSyncRecordV1, device: string | null): HealthSampleInput {
  const s: HealthSampleInput = {
    source_record_id: r.record_id,
    code: r.type,
    unit: r.unit,
    start: r.start,
    end: r.end,
    tz: r.tz,
  };
  if (r.value !== undefined) s.value = r.value;
  if (r.stats !== undefined) s.stats = { n: r.stats.n, sum: r.stats.sum, min: r.stats.min, max: r.stats.max };
  if (r.origin_app_id !== undefined) s.origin_app_id = r.origin_app_id;
  if (device) s.device = device;
  if (r.stages !== undefined) s.detail = { stages: r.stages };
  return s;
}

async function emitSafe(deps: HealthSyncDeps, event: Omit<CicdOasisEvent, 'vtid' | 'source'>): Promise<void> {
  try {
    const out = (await deps.emit({ vtid: HEALTH_SYNC_VTID, source: 'health-sync', ...event })) as { ok?: unknown } | undefined;
    if (out && typeof out === 'object' && out.ok === false) {
      deps.log({ event: 'health_sync_oasis_emit_failed', vtid: HEALTH_SYNC_VTID, type: event.type });
    }
  } catch {
    try {
      deps.log({ event: 'health_sync_oasis_emit_failed', vtid: HEALTH_SYNC_VTID, type: event.type });
    } catch {
      /* never throw */
    }
  }
}

export async function processHealthSyncBatch(
  identity: HealthSyncIdentity,
  batch: HealthSyncBatchV1,
  options: HealthSyncChannelOptions,
  deps: HealthSyncDeps,
): Promise<HealthSyncOutcome> {
  try {
    return await run(identity, batch, options, deps);
  } catch (err) {
    try {
      deps.log({ event: 'health_sync_batch_failed', vtid: HEALTH_SYNC_VTID, error: err instanceof Error ? err.name : typeof err });
    } catch {
      /* never throw */
    }
    return batchError('STORE_UNAVAILABLE');
  }
}

async function run(
  identity: HealthSyncIdentity,
  batch: HealthSyncBatchV1,
  options: HealthSyncChannelOptions,
  deps: HealthSyncDeps,
): Promise<HealthSyncOutcome> {
  const channel = options.channel;
  const sourceKind = channel === 'native' ? batch.source.kind : options.connector_id;
  const rejectedEvent = async (error: BatchErrorCode, categories: HealthSyncCategory[] = []) =>
    emitSafe(deps, {
      type: 'health.sync.batch.rejected',
      status: 'warning',
      message: `Health Sync batch rejected: ${error}.`,
      payload: { batch_id: batch.batch_id, source_kind: sourceKind, channel, error, categories },
      actor_id: identity.user_id,
      actor_role: 'user',
      surface: 'api',
    });

  // The consent resource is the source's connector id: the phone store, or the aggregator.
  const resource = channel === 'native' ? batch.source.kind : options.connector_id;

  // ---- 1. catalogue -----------------------------------------------------------------
  const rejected: RejectedRecord[] = [];
  const supported: Array<{ r: HealthSyncRecordV1; category: HealthSyncCategory }> = [];
  for (const r of batch.records) {
    const e = syncCatalogueEntry(r.type);
    if (!e) {
      rejected.push({ record_id: r.record_id, code: 'UNSUPPORTED_TYPE' });
      continue;
    }
    if (r.stages !== undefined && r.type !== 'sleep_session') {
      rejected.push({ record_id: r.record_id, code: 'INVALID_RECORD' });
      continue;
    }
    supported.push({ r, category: e.category });
  }
  const deletions: HealthDeletionInput[] = [];
  for (const d of batch.deletions) {
    if (!syncCatalogueEntry(d.type)) {
      rejected.push({ record_id: d.record_id, code: 'UNSUPPORTED_TYPE' });
      continue;
    }
    deletions.push({ source_record_id: d.record_id, code: d.type });
  }

  // ---- 2. consent, one read per category present (S7, fail closed) -------------
  // Before the source is resolved: an unconsented batch creates nothing.
  const categories = Array.from(new Set(supported.map((x) => x.category)));
  const consent: Partial<Record<HealthSyncCategory, ConsentState>> = {};
  await Promise.all(
    categories.map(async (category) => {
      let id: string | null = null;
      try {
        id = await deps.findConsentId(identity, HEALTH_SYNC_CONSENT_KEYS[category], resource);
      } catch {
        id = null;
      }
      consent[category] = typeof id === 'string' && id.length > 0 ? 'granted' : 'not_granted';
    }),
  );
  const consented = categories.filter((c) => consent[c] === 'granted');
  if (categories.length > 0 && consented.length === 0 && deletions.length === 0) {
    await rejectedEvent('CONSENT_REQUIRED', categories);
    return batchError('CONSENT_REQUIRED', { categories });
  }

  const device = channel === 'native' ? deviceLabel(batch) : null;
  const samples: HealthSampleInput[] = [];
  for (const { r, category } of supported) {
    if (consent[category] !== 'granted') {
      rejected.push({ record_id: r.record_id, code: 'CATEGORY_NOT_CONSENTED' });
      continue;
    }
    samples.push(toSample(r, device));
  }

  // ---- 3. source (S6): a phone store is created on first sync; an aggregator is only looked up --
  const toSend = samples.length > 0 || deletions.length > 0;
  const src = await deps.resolveSource(
    identity,
    channel === 'native'
      ? { kind: 'phone_store', connector_id: batch.source.kind, provider_user_id: batch.source.install_id, create: toSend }
      : { kind: 'aggregator', connector_id: options.connector_id, provider_user_id: options.provider_user_id },
  );
  if (!src.ok && !(src.code === 'SOURCE_NOT_CONNECTED' && !toSend)) {
    const out = src.code === 'STORE_PENDING' ? batchError('STORE_PENDING') : batchError('STORE_UNAVAILABLE');
    await rejectedEvent(out.body.error, categories);
    return out;
  }
  if (src.ok && (src.status === 'paused' || src.status === 'disconnected')) {
    await rejectedEvent('SOURCE_PAUSED', categories);
    return batchError('SOURCE_PAUSED');
  }
  const sourceState = src.ok ? src.status : 'not_connected';

  const counts: HealthSyncCounts = { stored: 0, duplicate: 0, updated: 0, deleted: 0, rejected: 0 };
  let replay = false;

  // ---- 4. hand off to A (S3) --------------------------------------------------------
  if (src.ok && toSend) {
    const result = await deps.writeHealthSamples({
      identity: { tenant_id: identity.tenant_id, user_id: identity.user_id },
      source_id: src.source_id,
      batch_id: batch.batch_id,
      via: channel === 'native' ? 'health_sync_native' : 'health_sync_aggregator',
      contract_version: batch.contract_version,
      samples,
      deletions,
    });
    if (!result.ok) {
      const out = mapStoreBatchError(result.code);
      await rejectedEvent(out.body.error, categories);
      return out;
    }
    replay = result.replay;
    for (const r of result.results) {
      switch (r.status) {
        case 'stored':
          counts.stored++;
          break;
        case 'updated':
          counts.updated++;
          break;
        case 'duplicate':
          counts.duplicate++;
          break;
        case 'deleted':
        case 'not_found':
          counts.deleted++;
          break;
        default: {
          const code = mapStoreRecordCode(r.status, r.code) ?? 'STORE_UNAVAILABLE';
          rejected.push(code === 'STORE_UNAVAILABLE' ? { record_id: r.source_record_id, code, retryable: true } : { record_id: r.source_record_id, code });
        }
      }
    }
  }
  counts.rejected = rejected.length;

  const rejectedByCode: Record<string, number> = {};
  for (const r of rejected) rejectedByCode[r.code] = (rejectedByCode[r.code] ?? 0) + 1;
  await emitSafe(deps, {
    type: 'health.sync.batch.processed',
    status: 'success',
    message: 'Health Sync batch processed.',
    payload: {
      batch_id: batch.batch_id,
      source_kind: sourceKind,
      channel,
      sync_mode: batch.sync_mode,
      replay,
      categories,
      consented_categories: consented,
      counts: { ...counts },
      rejected_by_code: rejectedByCode,
    },
    actor_id: identity.user_id,
    actor_role: 'user',
    surface: 'api',
  });

  return {
    status: 200,
    body: { ok: true, batch_id: batch.batch_id, replay, counts, rejected, consent, source_state: sourceState },
  };
}

// ---------------------------------------------------------------------------
// Aggregator (Phase 2): the interface only
// ---------------------------------------------------------------------------

/**
 * A Phase 2 aggregator adapter maps a VERIFIED webhook's normalised events into
 * one Health Sync v1 batch and calls processHealthSyncBatch with
 * channel:'aggregator'. The vendor is chosen in Phase 2; C1 ships only this
 * interface (and a fixture adapter in ./testing for tests). The legacy
 * Terra/Vital webhook path is not rerouted in C1 (planner Q3).
 */
export interface AggregatorBatchAdapter {
  /** connector_registry id of the aggregator (category 'aggregator'). */
  readonly connector_id: string;
  /** Normalised events of one verified delivery -> one v1 batch, or null when nothing maps. */
  toBatch(events: ReadonlyArray<Record<string, unknown>>, ctx: { provider_user_id: string; batch_id: string }): HealthSyncBatchV1 | null;
}

export async function processAggregatorDelivery(
  adapter: AggregatorBatchAdapter,
  identity: HealthSyncIdentity,
  events: ReadonlyArray<Record<string, unknown>>,
  ctx: { provider_user_id: string; batch_id: string },
  deps: HealthSyncDeps,
): Promise<HealthSyncOutcome | null> {
  let batch: HealthSyncBatchV1 | null;
  try {
    batch = adapter.toBatch(events, ctx);
  } catch {
    return batchError('INVALID_BATCH');
  }
  if (!batch) return null;
  // One schema for every channel: the adapter's batch is validated like a wire batch.
  const parsed = parseHealthSyncBatch(batch);
  if (!parsed.ok) return batchError(parsed.code, parsed.details ? { details: parsed.details } : {});
  batch = parsed.batch;
  return processHealthSyncBatch(identity, batch, { channel: 'aggregator', connector_id: adapter.connector_id, provider_user_id: ctx.provider_user_id }, deps);
}
