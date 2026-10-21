/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S3: writeHealthSamples, the single
 * write entry point of the health store.
 *
 * Shared interface S3 (plan docs/validation/VTID-05159/plan-sparring.md,
 * "Shared interfaces (Phase 1 A/B/C)", which wins over any other text):
 *
 *   writeHealthSamples(sb, { identity, source_id, batch_id, via, tz?, contract_version?, samples, deletions })
 *     -> { ok:true, replay, batch_id, results:[{ source_record_id, status, code? }] }
 *      | { ok:false, code:'STORE_DISABLED'|'STORE_PENDING'|'STORE_UNAVAILABLE'|'SOURCE_NOT_CONNECTED'
 *                         |'BATCH_ID_REUSED'|'QUOTA_EXCEEDED'|'INVALID_INPUT' }
 *
 * - Never throws: every failure is a result (a throwing repository, S3 client
 *   or consent read included).
 * - Order (plan Change 7): store flag -> input check -> source (S6) ->
 *   per-member DB quota -> batch idempotency -> consent per category (S7) ->
 *   raw archive of the consented subset (S3 bucket) -> validation and
 *   quarantine -> health_store_ingest in chunks of <= 2,000 -> batch row ->
 *   change hook if anything was deleted (S8).
 * - Replace is the only mode: the key is (source_id, source_record_id);
 *   series items are keyed by their aligned bucket (S1), so identical content
 *   is `duplicate` and different content `updated`.
 * - Consent is inside, per sample category, fail closed; the consent id is
 *   stored on every row and on the batch row. An unconsented sample is
 *   `skipped_no_consent` and is never archived, quarantined or stored.
 * - Deletions are processed whatever the consent state (S9).
 * - Results and logs carry codes and counts, never database messages or
 *   health values. Per-batch success is telemetry (structured log line +
 *   health_ingest_batches), not an OASIS event.
 */

import { createHash, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';
import { emitOasisEvent } from '../oasis-event-service';
import {
  findActiveHealthConsentId,
  hasHealthConsent,
  type HealthConsentCategoryKey,
} from '../consent/health-consent';
import { resolveHealthSource, type ResolveHealthSourceResult } from '../health-sources/health-sources';
import {
  healthCodeByKey,
  isSeriesKind,
  sourceRankOf,
  type HealthCode,
  type HealthDataCategory,
} from './catalogue';
import { healthStoreHooks, type HealthStoreHookRegistry, type HealthStoreIdentity } from './change-hook';
import { gateCategories } from './consent-gate';
import { getHealthStoreStatus, HEALTH_STORE_VTID, type HealthStoreStatus } from './flags';
import {
  healthStoreRepository,
  isHealthStoreMissing,
  isPartitionRoutingError,
  type HealthStoreRepository,
  type IngestChunkResult,
  type QuarantineRow,
  type RepoError,
} from './health-store-repository';
import { defaultRawBatchStore, rawBatchKey, type RawBatchStore } from './raw-batch-store';

// ---------------------------------------------------------------------------
// Types (S3)
// ---------------------------------------------------------------------------

export const HEALTH_STORE_VIAS = ['health_sync_native', 'health_sync_aggregator', 'internal', 'reprocess'] as const;
export type HealthStoreVia = (typeof HEALTH_STORE_VIAS)[number];

export interface HealthSampleStats {
  n: number;
  sum: number;
  min: number;
  max: number;
}

export interface HealthSampleInput {
  source_record_id: string;
  code: string;
  unit: string;
  start: string;
  end?: string | null;
  tz?: string | null;
  value?: number | null;
  stats?: HealthSampleStats | null;
  device?: string | null;
  origin_app_id?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface HealthDeletionInput {
  source_record_id: string;
  code: string;
}

export interface WriteHealthSamplesInput {
  identity: HealthStoreIdentity;
  source_id: string;
  batch_id: string;
  via: HealthStoreVia;
  tz?: string | null;
  contract_version?: string | null;
  samples: HealthSampleInput[];
  deletions: HealthDeletionInput[];
}

export type HealthSampleStatus =
  | 'stored'
  | 'updated'
  | 'duplicate'
  | 'deleted'
  | 'not_found'
  | 'quarantined'
  | 'invalid'
  | 'skipped_no_consent'
  | 'store_unavailable';

export interface HealthSampleResult {
  source_record_id: string;
  status: HealthSampleStatus;
  code?: string;
}

export type WriteHealthSamplesErrorCode =
  | 'STORE_DISABLED'
  | 'STORE_PENDING'
  | 'STORE_UNAVAILABLE'
  | 'SOURCE_NOT_CONNECTED'
  | 'BATCH_ID_REUSED'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_INPUT';

export type WriteHealthSamplesResult =
  | { ok: true; replay: boolean; batch_id: string; results: HealthSampleResult[] }
  | { ok: false; code: WriteHealthSamplesErrorCode };

// ---------------------------------------------------------------------------
// Limits (S3, plan Change 7)
// ---------------------------------------------------------------------------

export const HEALTH_STORE_LIMITS = Object.freeze({
  maxItemsPerCall: 5000,
  chunkSize: 2000,
  batchesPerDay: 500,
  itemsPerDay: 50_000,
  itemsPerDayBackfill: 250_000,
  backfillGraceDays: 7,
  retentionDays: 30,
  tooOldDays: 400,
  futureToleranceMs: 5 * 60 * 1000,
  /** The earliest partition of the lifetime tiers (A1 ensure_partitions lower bound). */
  earliestAcceptedIso: '2025-07-01T00:00:00.000Z',
  detailMaxBytes: 8192,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Dependencies (injectable: the S10 fake and the Jest suites build their own)
// ---------------------------------------------------------------------------

export interface HealthStoreDeps {
  repo: HealthStoreRepository;
  raw: RawBatchStore | null;
  status: () => HealthStoreStatus;
  resolveSource: (identity: HealthStoreIdentity, sourceId: string) => Promise<ResolveHealthSourceResult>;
  findConsentId: (identity: HealthStoreIdentity, key: HealthConsentCategoryKey, resourceId?: string | null) => Promise<string | null>;
  hasConsent: (identity: HealthStoreIdentity, key: HealthConsentCategoryKey, resourceId?: string | null) => Promise<boolean>;
  emit: (event: CicdOasisEvent) => Promise<unknown>;
  hooks: HealthStoreHookRegistry;
  now: () => Date;
  log: (line: Record<string, unknown>) => void;
}

export function defaultHealthStoreDeps(sb: SupabaseClient): HealthStoreDeps {
  return {
    repo: healthStoreRepository(sb),
    raw: defaultRawBatchStore(),
    status: () => getHealthStoreStatus(),
    resolveSource: (identity, sourceId) => resolveHealthSource(sb, identity, { source_id: sourceId }),
    findConsentId: (identity, key, resourceId) => findActiveHealthConsentId(sb, identity, key, resourceId),
    hasConsent: (identity, key, resourceId) => hasHealthConsent(sb, identity, key, resourceId),
    emit: (event) => emitOasisEvent(event),
    hooks: healthStoreHooks,
    now: () => new Date(),
    log: (line) => console.log(JSON.stringify(line)),
  };
}

/** Emit an OASIS event; a failure is logged, never thrown, never fails the caller. */
export async function emitHealthStoreEvent(deps: HealthStoreDeps, event: Omit<CicdOasisEvent, 'vtid' | 'source'>): Promise<void> {
  try {
    const out = (await deps.emit({ vtid: HEALTH_STORE_VTID, source: 'health-store', ...event })) as { ok?: unknown } | undefined;
    if (out && typeof out === 'object' && out.ok === false) {
      deps.log({ event: 'health_store_oasis_emit_failed', vtid: HEALTH_STORE_VTID, type: event.type });
    }
  } catch {
    deps.log({ event: 'health_store_oasis_emit_failed', vtid: HEALTH_STORE_VTID, type: event.type });
  }
}

export function storeErrorCode(error: RepoError | null | undefined): 'STORE_PENDING' | 'STORE_UNAVAILABLE' {
  return isHealthStoreMissing(error) ? 'STORE_PENDING' : 'STORE_UNAVAILABLE';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** Normalised-content hash of a call (identity and batch_id excluded). */
export function batchContentHash(input: WriteHealthSamplesInput): string {
  return createHash('sha256')
    .update(
      stableStringify({
        source_id: input.source_id,
        via: input.via,
        tz: input.tz ?? null,
        contract_version: input.contract_version ?? null,
        samples: input.samples,
        deletions: input.deletions,
      }),
    )
    .digest('hex');
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseTime(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function nonEmptyString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validIdentity(identity: unknown): identity is HealthStoreIdentity {
  const i = identity as HealthStoreIdentity | null;
  return !!i && nonEmptyString(i.tenant_id, 64) && nonEmptyString(i.user_id, 64);
}

/** Shape problems that make a sample unprocessable (INVALID_ITEM), checked before anything else. */
function sampleShapeOk(s: unknown): s is HealthSampleInput {
  if (!isPlainObject(s)) return false;
  if (!nonEmptyString(s.source_record_id, 256) || !nonEmptyString(s.code, 64) || !nonEmptyString(s.unit, 32)) return false;
  const start = parseTime(s.start);
  if (start === null) return false;
  if (s.end !== undefined && s.end !== null) {
    const end = parseTime(s.end);
    if (end === null || end < start) return false;
  }
  if (s.tz !== undefined && s.tz !== null && !isValidTimeZone(s.tz)) return false;
  if (s.device !== undefined && s.device !== null && !nonEmptyString(s.device, 256)) return false;
  if (s.origin_app_id !== undefined && s.origin_app_id !== null && !nonEmptyString(s.origin_app_id, 256)) return false;
  if (s.detail !== undefined && s.detail !== null) {
    if (!isPlainObject(s.detail)) return false;
    if (Buffer.byteLength(JSON.stringify(s.detail), 'utf8') > HEALTH_STORE_LIMITS.detailMaxBytes) return false;
  }
  return true;
}

/** Kind-specific shape (needs the catalogue entry). */
function kindShapeOk(s: HealthSampleInput, code: HealthCode): boolean {
  if (code.kind === 'series_sum') return finite(s.value) && (s.stats === undefined || s.stats === null);
  if (code.kind === 'series_stats') {
    const st = s.stats;
    return (
      isPlainObject(st) &&
      Number.isInteger(st.n) &&
      (st.n as number) > 0 &&
      finite(st.sum) &&
      finite(st.min) &&
      finite(st.max) &&
      (st.min as number) <= (st.max as number) &&
      (s.value === undefined || s.value === null)
    );
  }
  return (s.value === undefined || s.value === null || finite(s.value)) && (s.stats === undefined || s.stats === null);
}

type QuarantineReason =
  | 'UNIT_MISMATCH'
  | 'IMPLAUSIBLE'
  | 'MISALIGNED_BUCKET'
  | 'FUTURE'
  | 'TOO_OLD'
  | 'UNKNOWN_CODE'
  | 'CATEGORY_NOT_ALLOWED';

/** S3 validation of a consented sample; null = valid. */
function validationReason(s: HealthSampleInput, code: HealthCode, nowMs: number): QuarantineReason | null {
  if (!code.catalogue_allowed) return 'CATEGORY_NOT_ALLOWED';
  if (s.unit !== code.unit) return 'UNIT_MISMATCH';
  const start = parseTime(s.start) as number;
  if (start < nowMs - HEALTH_STORE_LIMITS.tooOldDays * DAY_MS || start < Date.parse(HEALTH_STORE_LIMITS.earliestAcceptedIso)) {
    return 'TOO_OLD';
  }
  const series = isSeriesKind(code.kind);
  const interval = start >= nowMs - HEALTH_STORE_LIMITS.retentionDays * DAY_MS ? FIVE_MIN_MS : HOUR_MS;
  const end = parseTime(s.end) ?? (series ? start + interval : start);
  if (end > nowMs + HEALTH_STORE_LIMITS.futureToleranceMs) return 'FUTURE';
  if (series && start % interval !== 0) return 'MISALIGNED_BUCKET';
  const lo = code.plausible_min;
  const hi = code.plausible_max;
  const outside = (v: number) => (lo !== null && v < lo) || (hi !== null && v > hi);
  if (code.kind === 'series_sum' && outside(s.value as number)) return 'IMPLAUSIBLE';
  if (code.kind === 'series_stats') {
    const st = s.stats as HealthSampleStats;
    if (outside(st.min) || outside(st.max)) return 'IMPLAUSIBLE';
  }
  if (code.kind === 'record' && finite(s.value) && outside(s.value)) return 'IMPLAUSIBLE';
  return null;
}

/** A series deletion's bucket from its record id "<code>:<start ISO>" (S1). */
function seriesDeletionBucket(d: HealthDeletionInput): string | null {
  const at = d.source_record_id.indexOf(':');
  if (at <= 0 || d.source_record_id.slice(0, at) !== d.code) return null;
  const ms = parseTime(d.source_record_id.slice(at + 1));
  return ms === null ? null : new Date(ms).toISOString();
}

interface StoreItem {
  /** index into results */
  ri: number;
  series: boolean;
  payload: Record<string, unknown>;
  category: HealthDataCategory;
}

interface StoreGroup {
  consent_id: string | null;
  tz: string;
  items: StoreItem[];
}

function mapSqlStatus(status: string): { status: HealthSampleStatus; code?: string } {
  switch (status) {
    case 'stored':
    case 'updated':
    case 'duplicate':
    case 'deleted':
    case 'not_found':
      return { status };
    case 'suppressed':
      // The member withdrew this data (S9 suppression); a resend never resurrects it.
      return { status: 'skipped_no_consent', code: 'WITHDRAWN' };
    case 'invalid':
      return { status: 'invalid', code: 'INVALID_ITEM' };
    default:
      return { status: 'store_unavailable' };
  }
}

// ---------------------------------------------------------------------------
// writeHealthSamples
// ---------------------------------------------------------------------------

export async function writeHealthSamples(sb: SupabaseClient, input: WriteHealthSamplesInput): Promise<WriteHealthSamplesResult> {
  let deps: HealthStoreDeps;
  try {
    deps = defaultHealthStoreDeps(sb);
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
  return writeHealthSamplesWith(deps, input);
}

export async function writeHealthSamplesWith(deps: HealthStoreDeps, input: WriteHealthSamplesInput): Promise<WriteHealthSamplesResult> {
  try {
    return await write(deps, input);
  } catch (err) {
    try {
      deps.log({ event: 'health_store_ingest_failed', vtid: HEALTH_STORE_VTID, code: 'STORE_UNAVAILABLE', error: err instanceof Error ? err.name : typeof err });
    } catch {
      /* never throw */
    }
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

async function write(deps: HealthStoreDeps, input: WriteHealthSamplesInput): Promise<WriteHealthSamplesResult> {
  const t0 = Date.now();
  if (!deps.status().enabled) return { ok: false, code: 'STORE_DISABLED' };

  // ---- input -------------------------------------------------------------
  if (!input || typeof input !== 'object') return { ok: false, code: 'INVALID_INPUT' };
  const { identity, source_id, batch_id, via } = input;
  const samples = input.samples as unknown[];
  const deletions = input.deletions as unknown[];
  if (
    !validIdentity(identity) ||
    !nonEmptyString(source_id, 64) ||
    typeof batch_id !== 'string' ||
    !UUID_RE.test(batch_id) ||
    !(HEALTH_STORE_VIAS as readonly string[]).includes(via) ||
    !Array.isArray(samples) ||
    !Array.isArray(deletions) ||
    samples.length + deletions.length > HEALTH_STORE_LIMITS.maxItemsPerCall ||
    (input.tz !== undefined && input.tz !== null && !isValidTimeZone(input.tz)) ||
    (input.contract_version !== undefined && input.contract_version !== null && !nonEmptyString(input.contract_version, 16))
  ) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  const batchTz = input.tz ?? 'UTC';
  const now = deps.now();
  const nowMs = now.getTime();
  const since30 = new Date(nowMs - HEALTH_STORE_LIMITS.retentionDays * DAY_MS).toISOString();

  // ---- source (S6) -------------------------------------------------------
  const src = await deps.resolveSource(identity, source_id);
  if (!src.ok) return { ok: false, code: src.code };
  if (src.status === 'disconnected' && samples.length > 0) return { ok: false, code: 'SOURCE_NOT_CONNECTED' };
  const sourceRank = sourceRankOf(src.kind);

  // ---- per-member DB quota ------------------------------------------------
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const today = await deps.repo.listBatchCountsSince(identity.user_id, dayStart);
  if (today.error) return { ok: false, code: storeErrorCode(today.error) };
  const first = await deps.repo.firstBatchForSource(identity.user_id, source_id, since30);
  if (first.error) return { ok: false, code: storeErrorCode(first.error) };
  const firstAt = first.data?.received_at ? Date.parse(first.data.received_at) : null;
  const isFirstBatch = firstAt === null;
  const inGrace = isFirstBatch || (firstAt as number) >= nowMs - HEALTH_STORE_LIMITS.backfillGraceDays * DAY_MS;
  const itemLimit = inGrace ? HEALTH_STORE_LIMITS.itemsPerDayBackfill : HEALTH_STORE_LIMITS.itemsPerDay;
  const rows = today.data ?? [];
  const itemsToday = rows.reduce((a, r) => a + (r.accepted ?? 0) + (r.quarantined ?? 0) + (r.rejected ?? 0), 0);
  const totalItems = samples.length + deletions.length;
  if (rows.length >= HEALTH_STORE_LIMITS.batchesPerDay || itemsToday + totalItems > itemLimit) {
    deps.log({ event: 'health_store_quota_exceeded', vtid: HEALTH_STORE_VTID, batches_today: rows.length, items_today: itemsToday });
    await emitHealthStoreEvent(deps, {
      type: 'health.store.quota.exceeded',
      status: 'warning',
      message: 'Health store per-member daily quota exceeded; batch refused.',
      payload: {
        source_id,
        batch_id,
        batches_today: rows.length,
        items_today: itemsToday,
        items_in_batch: totalItems,
        item_limit: itemLimit,
      },
      actor_role: 'system',
      surface: 'system',
    });
    return { ok: false, code: 'QUOTA_EXCEEDED' };
  }

  // ---- batch idempotency ---------------------------------------------------
  const bodyHash = batchContentHash(input);
  const existing = await deps.repo.findBatch(identity.user_id, batch_id, since30);
  if (existing.error) return { ok: false, code: storeErrorCode(existing.error) };
  if (existing.data) {
    if (existing.data.body_sha256 !== bodyHash) return { ok: false, code: 'BATCH_ID_REUSED' };
    const stored = (existing.data.results as { results?: unknown } | null)?.results;
    if (Array.isArray(stored)) return { ok: true, replay: true, batch_id, results: stored as HealthSampleResult[] };
  }

  // ---- shape and catalogue ---------------------------------------------------
  const results: HealthSampleResult[] = new Array(totalItems);
  const quarantine: QuarantineRow[] = [];
  const candidates: Array<{ i: number; s: HealthSampleInput; code: HealthCode }> = [];
  samples.forEach((raw, i) => {
    const rid = isPlainObject(raw) && typeof raw.source_record_id === 'string' ? (raw.source_record_id as string) : '';
    if (!sampleShapeOk(raw)) {
      results[i] = { source_record_id: rid, status: 'invalid', code: 'INVALID_ITEM' };
      return;
    }
    const code = healthCodeByKey(raw.code);
    if (!code) {
      // No category, so no consent can cover it: quarantined by key only, never archived.
      results[i] = { source_record_id: rid, status: 'quarantined', code: 'UNKNOWN_CODE' };
      quarantine.push({ tenant_id: identity.tenant_id, user_id: identity.user_id, batch_id, item_index: i, code_key: raw.code.slice(0, 64), reason: 'UNKNOWN_CODE' });
      return;
    }
    if (!kindShapeOk(raw, code)) {
      results[i] = { source_record_id: rid, status: 'invalid', code: 'INVALID_ITEM' };
      return;
    }
    candidates.push({ i, s: raw, code });
  });

  // ---- consent (S7), one read per category present -----------------------
  const gate = await gateCategories(
    identity,
    { kind: src.kind, connector_id: src.connector_id },
    candidates.map((c) => c.code.category),
    deps.findConsentId,
  );
  const consented: Array<{ i: number; s: HealthSampleInput; code: HealthCode; consent_id: string }> = [];
  for (const c of candidates) {
    const g = gate.get(c.code.category);
    if (!g || !g.ok) {
      results[c.i] = { source_record_id: c.s.source_record_id, status: 'skipped_no_consent', code: g && !g.ok ? g.code : 'CONSENT_REQUIRED' };
      continue;
    }
    consented.push({ ...c, consent_id: g.consent_id });
  }

  // ---- deletions (no consent check, S9) ----------------------------------------
  const deletionItems: StoreItem[] = [];
  deletions.forEach((raw, j) => {
    const ri = samples.length + j;
    const d = raw as HealthDeletionInput;
    const rid = isPlainObject(raw) && typeof raw.source_record_id === 'string' ? (raw.source_record_id as string) : '';
    const code = isPlainObject(raw) && nonEmptyString(d.source_record_id, 256) && nonEmptyString(d.code, 64) ? healthCodeByKey(d.code) : null;
    if (!code) {
      results[ri] = { source_record_id: rid, status: 'invalid', code: 'INVALID_ITEM' };
      return;
    }
    if (isSeriesKind(code.kind)) {
      const bucket = seriesDeletionBucket(d);
      if (!bucket) {
        results[ri] = { source_record_id: rid, status: 'invalid', code: 'INVALID_ITEM' };
        return;
      }
      deletionItems.push({ ri, series: true, category: code.category, payload: { code_id: code.code_id, bucket_start: bucket, op: 'delete' } });
    } else {
      deletionItems.push({ ri, series: false, category: code.category, payload: { source_record_id: d.source_record_id, code_id: code.code_id, op: 'delete' } });
    }
  });

  // ---- raw archive of the consented subset -------------------------------------
  let s3Key: string | null = null;
  if (consented.length > 0) {
    if (!deps.raw) return { ok: false, code: 'STORE_UNAVAILABLE' };
    s3Key = rawBatchKey(identity.user_id, source_id, batch_id, now);
    const put = await deps.raw.put(s3Key, {
      vtid: HEALTH_STORE_VTID,
      batch_id,
      source_id,
      via,
      tz: input.tz ?? null,
      contract_version: input.contract_version ?? null,
      received_at: now.toISOString(),
      samples: consented.map((c) => c.s),
      deletions: deletions,
    });
    if (!put.ok) return { ok: false, code: 'STORE_UNAVAILABLE' };
  }

  // ---- validation and quarantine --------------------------------------------------
  const groups = new Map<string, StoreGroup>();
  const groupFor = (consentId: string | null, tz: string): StoreGroup => {
    const k = `${consentId ?? ''}|${tz}`;
    let g = groups.get(k);
    if (!g) {
      g = { consent_id: consentId, tz, items: [] };
      groups.set(k, g);
    }
    return g;
  };
  for (const c of consented) {
    const reason = validationReason(c.s, c.code, nowMs);
    if (reason) {
      results[c.i] = { source_record_id: c.s.source_record_id, status: 'quarantined', code: reason };
      quarantine.push({ tenant_id: identity.tenant_id, user_id: identity.user_id, batch_id, item_index: c.i, code_key: c.code.key, reason });
      continue;
    }
    const startIso = new Date(parseTime(c.s.start) as number).toISOString();
    const tz = c.s.tz ?? batchTz;
    let payload: Record<string, unknown>;
    if (c.code.kind === 'series_sum') {
      const v = c.s.value as number;
      payload = { code_id: c.code.code_id, bucket_start: startIso, n: 1, sum: v, min: v, max: v };
    } else if (c.code.kind === 'series_stats') {
      const st = c.s.stats as HealthSampleStats;
      payload = { code_id: c.code.code_id, bucket_start: startIso, n: st.n, sum: st.sum, min: st.min, max: st.max };
    } else {
      const end = parseTime(c.s.end);
      payload = {
        source_record_id: c.s.source_record_id,
        code_id: c.code.code_id,
        value: finite(c.s.value) ? c.s.value : null,
        unit: c.s.unit,
        effective_start: startIso,
        effective_end: end === null ? null : new Date(end).toISOString(),
        device: c.s.device ?? null,
        detail: c.s.detail ?? null,
      };
    }
    groupFor(c.consent_id, tz).items.push({ ri: c.i, series: isSeriesKind(c.code.kind), payload, category: c.code.category });
  }
  if (deletionItems.length > 0) groupFor(null, batchTz).items.push(...deletionItems);

  if (quarantine.length > 0) {
    const q = await deps.repo.insertQuarantine(quarantine);
    if (q.error) deps.log({ event: 'health_store_quarantine_write_failed', vtid: HEALTH_STORE_VTID, batch_id, code: q.error.code ?? 'unknown', rows: quarantine.length });
  }

  // ---- store write, chunks of <= 2,000 ------------------------------------------------
  const deletedDates = new Set<string>();
  const deletedCategories = new Set<HealthDataCategory>();
  let ensured = false;
  let anyChunkCommitted = false;
  let partitionMissing = 0;

  for (const group of groups.values()) {
    for (let off = 0; off < group.items.length; off += HEALTH_STORE_LIMITS.chunkSize) {
      const chunk = group.items.slice(off, off + HEALTH_STORE_LIMITS.chunkSize);
      const seriesItems = chunk.filter((x) => x.series);
      const recordItems = chunk.filter((x) => !x.series);
      const params = {
        tenant_id: identity.tenant_id,
        user_id: identity.user_id,
        batch_id,
        source_id,
        source_kind: src.kind,
        source_rank: sourceRank,
        consent_id: group.consent_id,
        tz: group.tz,
        series: seriesItems.map((x) => x.payload),
        records: recordItems.map((x) => x.payload),
      };
      let res = await deps.repo.ingestChunk(params);
      if (res.error && isPartitionRoutingError(res.error) && !ensured) {
        ensured = true;
        await deps.repo.ensurePartitions(new Date(nowMs).toISOString());
        res = await deps.repo.ingestChunk(params);
      }
      if (res.error || !res.data) {
        if (!anyChunkCommitted && isHealthStoreMissing(res.error)) {
          if (s3Key && deps.raw) await deps.raw.delete(s3Key);
          return { ok: false, code: 'STORE_PENDING' };
        }
        const partition = isPartitionRoutingError(res.error);
        if (partition) partitionMissing += chunk.length;
        deps.log({
          event: partition ? 'health.store.partition_missing' : 'health_store_chunk_failed',
          vtid: HEALTH_STORE_VTID,
          batch_id,
          code: res.error?.code ?? 'unknown',
          items: chunk.length,
        });
        for (const x of chunk) results[x.ri] = { source_record_id: sourceRecordIdOf(input, x.ri), status: 'store_unavailable' };
        continue;
      }
      anyChunkCommitted = true;
      const data = res.data as IngestChunkResult;
      const apply = (items: StoreItem[], statuses: Array<{ i: number; status: string }> | undefined) => {
        const byIndex = new Map((statuses ?? []).map((s) => [s.i, s.status]));
        items.forEach((x, k) => {
          const mapped = mapSqlStatus(byIndex.get(k) ?? 'unknown');
          results[x.ri] = { source_record_id: sourceRecordIdOf(input, x.ri), ...mapped };
          if (mapped.status === 'deleted') deletedCategories.add(x.category);
        });
      };
      apply(seriesItems, data.series);
      apply(recordItems, data.records);
      for (const d of data.deleted_dates ?? []) deletedDates.add(String(d));
    }
  }

  // ---- batch row -------------------------------------------------------------
  const counts: Record<HealthSampleStatus, number> = {
    stored: 0,
    updated: 0,
    duplicate: 0,
    deleted: 0,
    not_found: 0,
    quarantined: 0,
    invalid: 0,
    skipped_no_consent: 0,
    store_unavailable: 0,
  };
  for (const r of results) counts[r.status] += 1;
  const accepted = counts.stored + counts.updated + counts.duplicate + counts.deleted + counts.not_found;
  const rejected = counts.invalid + counts.skipped_no_consent + counts.store_unavailable;
  const consentIds = Array.from(new Set(consented.map((c) => c.consent_id)));
  const status: 'stored' | 'partial' | 'failed' =
    counts.store_unavailable > 0 && accepted === 0 ? 'failed' : rejected + counts.quarantined > 0 ? 'partial' : 'stored';
  const batchRow = await deps.repo.insertBatch({
    tenant_id: identity.tenant_id,
    user_id: identity.user_id,
    batch_id,
    body_sha256: bodyHash,
    source_id,
    via,
    contract_version: input.contract_version ?? null,
    tz: input.tz ?? null,
    s3_key: s3Key,
    consent_id: consentIds.length === 1 ? consentIds[0] : null,
    accepted,
    quarantined: counts.quarantined,
    rejected,
    status,
    results: { results, consent_ids: consentIds },
    received_at: now.toISOString(),
    completed_at: new Date(deps.now().getTime()).toISOString(),
  });
  if (batchRow.error) {
    deps.log({ event: 'health_store_batch_row_failed', vtid: HEALTH_STORE_VTID, batch_id, code: batchRow.error.code ?? 'unknown' });
  }

  // ---- OASIS (state transitions only; ids and counts, never values) -----------------
  if (isFirstBatch && counts.stored + counts.updated > 0) {
    await emitHealthStoreEvent(deps, {
      type: 'health.store.source.first_data',
      status: 'info',
      message: 'First data stored for a health source.',
      payload: { source_id, source_kind: src.kind, batch_id, stored: counts.stored + counts.updated },
      actor_role: 'system',
      surface: 'system',
    });
  }
  if (counts.quarantined > 0) {
    const byReason: Record<string, number> = {};
    for (const r of results) if (r.status === 'quarantined' && r.code) byReason[r.code] = (byReason[r.code] ?? 0) + 1;
    await emitHealthStoreEvent(deps, {
      type: 'health.store.batch.quarantined',
      status: 'warning',
      message: 'Health store batch had quarantined items.',
      payload: { source_id, batch_id, quarantined: counts.quarantined, by_reason: byReason },
      actor_role: 'system',
      surface: 'system',
    });
  }
  if (partitionMissing > 0) {
    await emitHealthStoreEvent(deps, {
      type: 'health.store.partition_missing',
      status: 'error',
      message: 'Health store write found no partition after one ensure + retry; items answered store_unavailable.',
      payload: { batch_id, items: partitionMissing },
      actor_role: 'system',
      surface: 'system',
    });
  }

  // ---- change hook (S8) after committed deletions ---------------------------------
  if (counts.deleted > 0) {
    deps.hooks.fire(identity, {
      dates: Array.from(deletedDates).sort(),
      categories: Array.from(deletedCategories),
      source_id,
    });
  }

  deps.log({
    event: 'health_store_ingest',
    vtid: HEALTH_STORE_VTID,
    via,
    batch_id,
    items: totalItems,
    ...counts,
    latency_ms: Date.now() - t0,
  });

  return { ok: true, replay: false, batch_id, results };
}

function sourceRecordIdOf(input: WriteHealthSamplesInput, ri: number): string {
  const item = ri < input.samples.length ? input.samples[ri] : input.deletions[ri - input.samples.length];
  return item && typeof item.source_record_id === 'string' ? item.source_record_id : '';
}

// ---------------------------------------------------------------------------
// Reprocess (POST /api/v1/health/internal/reprocess)
// ---------------------------------------------------------------------------

export type ReprocessResult = WriteHealthSamplesResult | { ok: false; code: 'BATCH_NOT_FOUND' | 'RAW_BATCH_MISSING' };

/**
 * Re-reads a stored raw batch and runs writeHealthSamples again
 * (via:'reprocess', a new batch id) with the CURRENT consent and catalogue —
 * idempotent by replace; a revoked consent means nothing is written.
 */
export async function reprocessHealthBatchWith(deps: HealthStoreDeps, batchId: string): Promise<ReprocessResult> {
  try {
    if (!deps.status().enabled) return { ok: false, code: 'STORE_DISABLED' };
    if (typeof batchId !== 'string' || !UUID_RE.test(batchId)) return { ok: false, code: 'INVALID_INPUT' };
    const since30 = new Date(deps.now().getTime() - HEALTH_STORE_LIMITS.retentionDays * DAY_MS).toISOString();
    const found = await deps.repo.findBatchById(batchId, since30);
    if (found.error) return { ok: false, code: storeErrorCode(found.error) };
    const row = found.data;
    if (!row) return { ok: false, code: 'BATCH_NOT_FOUND' };
    if (!row.s3_key || !deps.raw) return { ok: false, code: 'RAW_BATCH_MISSING' };
    const got = await deps.raw.get(row.s3_key);
    if (!got.ok) return { ok: false, code: 'STORE_UNAVAILABLE' };
    const payload = got.payload as { samples?: unknown; deletions?: unknown; tz?: unknown; contract_version?: unknown } | null;
    if (!payload || !Array.isArray(payload.samples)) return { ok: false, code: 'RAW_BATCH_MISSING' };
    return writeHealthSamplesWith(deps, {
      identity: { tenant_id: row.tenant_id, user_id: row.user_id },
      source_id: row.source_id,
      batch_id: randomUUID(),
      via: 'reprocess',
      tz: typeof payload.tz === 'string' ? payload.tz : null,
      contract_version: typeof payload.contract_version === 'string' ? payload.contract_version : null,
      samples: payload.samples as HealthSampleInput[],
      deletions: Array.isArray(payload.deletions) ? (payload.deletions as HealthDeletionInput[]) : [],
    });
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

export function reprocessHealthBatch(sb: SupabaseClient, batchId: string): Promise<ReprocessResult> {
  return reprocessHealthBatchWith(defaultHealthStoreDeps(sb), batchId);
}
