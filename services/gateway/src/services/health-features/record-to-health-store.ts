/**
 * VTID-05162 (Health Hub Phase 1 / B2) — B Change 7: every legacy health
 * writer also writes into package A's health store.
 *
 *   recordToHealthStore(sb, identity, writerId, values, opts?)
 *
 * Each writer in WRITER_SPEC calls this AFTER its legacy write succeeded. It
 * never changes the legacy response: it never throws, every failure is
 * counted, logged with a code and (rate-limited) emitted as OASIS
 * `health.features.dual_write_failed` (writer + code + counts, never a member
 * id or a health value). The caller ignores the result.
 *
 * Order:
 *   1. the writer's flag (HEALTH_STORE_DUAL_WRITE_DEVICE / _SELF_LOGGED, exact
 *      'true', never on staging) — off: nothing is read or written;
 *   2. the store's own flag (HEALTH_STORE_ENABLED) — off: nothing is touched;
 *   3. the source (S6): the member's own manual / voice / diary source via
 *      resolveHealthSource(create:true); a device cloud by the legacy
 *      user_connections id its connection flow mirrored (B1);
 *   4. writeHealthSamples (S3) — the consent gate is A's ingest, B never
 *      writes observations itself; `source_record_id` per WRITER_SPEC;
 *   5. a pending marker per member-day that changed, written BEFORE this
 *      function returns (so before the caller's response);
 *   6. the derivation of those days, scheduled after the response.
 *
 * VTID-05163 (B3) — `opts.cutover: true` (the writer is cut over, cutover.ts):
 * the same steps 1–5, but every failure is FATAL and returned to the caller
 * (store off, no tenant, call-level ok:false, and any sample that was not
 * stored — S3 "fatal only in derived mode"), every item date is derived (not
 * only the changed ones), and step 6 runs SYNCHRONOUSLY with target 'live'
 * (deriveAndStore publishes into health_features_daily for dates >= C), so the
 * writer's own Index recompute that follows sees the row. A pending-marker
 * write failure stays non-fatal (the marker is only crash recovery).
 *
 * Self-logged writers stay dark until C1's `self_logged_health` consent key
 * is live (S7): until then A answers skipped_no_consent /
 * CONSENT_CATEGORY_MISSING for every sample, which is counted like any other
 * non-stored status. The legacy path is not newly gated here.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';
import { emitOasisEvent } from '../oasis-event-service';
import {
  resolveHealthSource,
  resolveHealthSourceByLegacyConnection,
  type ResolveHealthSourceResult,
} from '../health-sources/health-sources';
import type { HealthStoreIdentity } from '../health-store/change-hook';
import { healthCodeByKey, isSeriesKind } from '../health-store/catalogue';
import { getHealthStoreStatus, type HealthStoreStatus } from '../health-store/flags';
import {
  writeHealthSamples,
  type HealthDeletionInput,
  type HealthSampleInput,
  type HealthSampleStatus,
  type WriteHealthSamplesInput,
  type WriteHealthSamplesResult,
} from '../health-store/ingest';
import { defaultDerivationDeps, deriveAndStore, type DerivationDeps } from './derive-daily-features';
import { HEALTH_FEATURES_VTID, WRITER_SPEC, type HealthWriterId, type WriterValue } from './feature-spec';
import { isDualWriteEnabledFor } from './flags';
import { derivationTargetFor } from './cutover';
import { featuresErrorCode, healthFeaturesRepository, type HealthFeaturesRepository } from './health-features-repository';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The zero-UUID some legacy writers fall back to when a member has no tenant row. */
export const LEGACY_FALLBACK_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface RecordOptions {
  /** device_cloud writers: the legacy user_connections row the event belongs to. */
  legacy_user_connection_id?: string | null;
  /** device_cloud / webhook_workout: the connector id (oura, fitbit, …). */
  connector_id?: string | null;
  /** per_call writers: a stable id for this call (e.g. the action id); default a new uuid. */
  call_id?: string | null;
  /** VTID-05163: the writer is cut over (isWriterCutOver / isFeatureWriteCutOver) — fatal, synchronous 'live'. */
  cutover?: boolean;
}

export type RecordSkip = 'flag_off' | 'store_disabled' | 'no_tenant' | 'no_values' | 'unknown_writer';

export type RecordResult =
  | { ok: true; skipped: RecordSkip }
  | { ok: true; counts: Partial<Record<HealthSampleStatus, number>>; dates: string[]; marker: 'written' | 'failed' | 'none' }
  | { ok: false; code: string };

export interface RecordDeps {
  env: NodeJS.ProcessEnv;
  storeStatus: () => HealthStoreStatus;
  resolveSelfLogged: (identity: HealthStoreIdentity, kind: 'manual' | 'voice' | 'diary') => Promise<ResolveHealthSourceResult>;
  resolveDevice: (identity: HealthStoreIdentity, legacyUserConnectionId: string) => Promise<ResolveHealthSourceResult>;
  write: (input: WriteHealthSamplesInput) => Promise<WriteHealthSamplesResult>;
  repo: HealthFeaturesRepository;
  derivation: DerivationDeps;
  /** Runs the derivation after the caller's response (default: setImmediate). */
  schedule: (fn: () => Promise<unknown>) => void;
  emit: (event: CicdOasisEvent) => Promise<unknown>;
  now: () => Date;
  log: (line: Record<string, unknown>) => void;
  newId: () => string;
}

export function defaultRecordDeps(sb: SupabaseClient): RecordDeps {
  return {
    env: process.env,
    storeStatus: () => getHealthStoreStatus(),
    resolveSelfLogged: (identity, kind) => resolveHealthSource(sb, identity, { kind, create: true }),
    resolveDevice: (identity, legacyId) => resolveHealthSourceByLegacyConnection(sb, identity, legacyId),
    write: (input) => writeHealthSamples(sb, input),
    repo: healthFeaturesRepository(sb),
    derivation: defaultDerivationDeps(sb),
    schedule: (fn) => {
      setImmediate(() => {
        void Promise.resolve().then(fn).catch(() => undefined);
      });
    },
    emit: (event) => emitOasisEvent(event),
    now: () => new Date(),
    log: (line) => console.log(JSON.stringify(line)),
    newId: () => randomUUID(),
  };
}

// ---- outcome accounting (codes and counts only) --------------------------------

const OASIS_INTERVAL_MS = 60_000;
const counters = new Map<string, number>();
const lastEmit = new Map<string, { at: number; pending: number }>();

/** Per writer+status/code counts since process start (tests, diagnostics, B3's store_write_failed input). */
export function getHealthStoreDualWriteCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetHealthStoreDualWriteCounters(): void {
  counters.clear();
  lastEmit.clear();
}

function count(key: string, n = 1): void {
  counters.set(key, (counters.get(key) ?? 0) + n);
}

function safeLog(deps: RecordDeps, line: Record<string, unknown>): void {
  try {
    deps.log({ vtid: HEALTH_FEATURES_VTID, ...line });
  } catch {
    /* never throw */
  }
}

async function reportFailure(deps: RecordDeps, writer: HealthWriterId, code: string, extra: Record<string, unknown> = {}): Promise<void> {
  count(`${writer}:${code}`);
  safeLog(deps, { event: 'health_store_dual_write_failed', writer, code, ...extra });
  const key = `${writer}:${code}`;
  const now = deps.now().getTime();
  const last = lastEmit.get(key);
  if (last && now - last.at < OASIS_INTERVAL_MS) {
    last.pending += 1;
    return;
  }
  const suppressed = last?.pending ?? 0;
  lastEmit.set(key, { at: now, pending: 0 });
  try {
    await deps.emit({
      vtid: HEALTH_FEATURES_VTID,
      type: 'health.features.dual_write_failed',
      source: 'health-features',
      status: 'warning',
      message: `Health store dual-write failed for writer ${writer}: ${code}`,
      payload: { writer, code, ...extra, suppressed_since_last: suppressed },
      actor_role: 'system',
      surface: 'system',
    });
  } catch {
    /* OASIS is best-effort */
  }
}

// ---- samples ------------------------------------------------------------------------

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 96);
}

/** The writer's source_record_id for one value (WRITER_SPEC.key). */
export function sourceRecordIdFor(writer: HealthWriterId, v: WriterValue, opts: RecordOptions, callId: string): string | null {
  const spec = WRITER_SPEC[writer];
  switch (spec.key) {
    case 'deterministic':
      return `${writer}:${v.date}:${v.code}${typeof v.index === 'number' ? `:${v.index}` : ''}`;
    case 'per_call':
      return `${writer}:${sanitize(callId)}${typeof v.index === 'number' ? `:${v.index}` : ''}`;
    case 'external': {
      if (!opts.connector_id || !v.external_id) return null;
      return `${sanitize(opts.connector_id)}:${sanitize(v.external_id)}`;
    }
  }
}

interface BuiltItems {
  samples: HealthSampleInput[];
  deletions: HealthDeletionInput[];
  /** The legacy date of every item, samples first then deletions (the order of S3's results). */
  dates: string[];
}

function buildItems(writer: HealthWriterId, values: WriterValue[], opts: RecordOptions, callId: string): BuiltItems {
  const samples: HealthSampleInput[] = [];
  const sampleDates: string[] = [];
  const deletions: HealthDeletionInput[] = [];
  const deletionDates: string[] = [];
  for (const v of values) {
    if (!v || typeof v.code !== 'string' || typeof v.date !== 'string' || !DATE_RE.test(v.date)) continue;
    const code = healthCodeByKey(v.code);
    if (!code) continue;
    const start = v.start ?? `${v.date}T00:00:00.000Z`;
    if (v.delete) {
      // A series deletion names its aligned bucket: "<code>:<bucket start>" (S1).
      const rid = isSeriesKind(code.kind) ? `${v.code}:${new Date(Date.parse(start)).toISOString()}` : sourceRecordIdFor(writer, v, opts, callId);
      if (!rid) continue;
      deletions.push({ source_record_id: rid, code: v.code });
      deletionDates.push(v.date);
      continue;
    }
    const rid = sourceRecordIdFor(writer, v, opts, callId);
    if (!rid) continue;
    const s: HealthSampleInput = { source_record_id: rid, code: v.code, unit: code.unit, start };
    if (v.end) s.end = v.end;
    if (code.kind === 'series_stats') s.stats = v.stats ?? null;
    else s.value = typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : null;
    if (v.detail) s.detail = v.detail;
    samples.push(s);
    sampleDates.push(v.date);
  }
  return { samples, deletions, dates: [...sampleDates, ...deletionDates] };
}

function validIdentity(i: HealthStoreIdentity | null | undefined): i is HealthStoreIdentity {
  return !!i && typeof i.tenant_id === 'string' && i.tenant_id.length > 0 && i.tenant_id !== LEGACY_FALLBACK_TENANT_ID
    && typeof i.user_id === 'string' && i.user_id.length > 0;
}

// ---- entry point ----------------------------------------------------------------------

export async function recordToHealthStore(
  sb: SupabaseClient | null | undefined,
  identity: HealthStoreIdentity,
  writerId: HealthWriterId,
  values: WriterValue[],
  opts: RecordOptions = {},
  depsOverride?: Partial<RecordDeps>,
): Promise<RecordResult> {
  try {
    const spec = WRITER_SPEC[writerId];
    if (!spec) return { ok: true, skipped: 'unknown_writer' };
    const env = depsOverride?.env ?? process.env;
    // 1. the writer's flag: off -> nothing is read or written, no deps are built.
    if (!isDualWriteEnabledFor(spec.flag, env)) return { ok: true, skipped: 'flag_off' };
    if (!sb && !depsOverride) return { ok: true, skipped: 'store_disabled' };
    const deps: RecordDeps = { ...defaultRecordDeps(sb as SupabaseClient), ...depsOverride, env };
    return await record(deps, spec.writer, identity, values, opts);
  } catch {
    return { ok: false, code: 'THREW' };
  }
}

async function record(deps: RecordDeps, writer: HealthWriterId, identity: HealthStoreIdentity, values: WriterValue[], opts: RecordOptions): Promise<RecordResult> {
  const spec = WRITER_SPEC[writer];
  const cutover = opts.cutover === true;
  // 2. the store's own flag.
  if (!deps.storeStatus().enabled) {
    count(`${writer}:STORE_DISABLED`);
    if (cutover) {
      await reportFailure(deps, writer, 'STORE_DISABLED');
      return { ok: false, code: 'STORE_DISABLED' };
    }
    return { ok: true, skipped: 'store_disabled' };
  }
  if (!validIdentity(identity)) {
    count(`${writer}:NO_TENANT`);
    if (cutover) return { ok: false, code: 'NO_TENANT' };
    return { ok: true, skipped: 'no_tenant' };
  }
  const callId = opts.call_id || deps.newId();
  const { samples, deletions, dates: itemDates } = buildItems(writer, Array.isArray(values) ? values : [], opts, callId);
  if (samples.length + deletions.length === 0) {
    count(`${writer}:NO_VALUES`);
    return { ok: true, skipped: 'no_values' };
  }

  // 3. the source.
  let src: ResolveHealthSourceResult;
  if (spec.kind === 'device_cloud') {
    if (!opts.legacy_user_connection_id) {
      await reportFailure(deps, writer, 'SOURCE_NOT_CONNECTED');
      return { ok: false, code: 'SOURCE_NOT_CONNECTED' };
    }
    src = await deps.resolveDevice(identity, opts.legacy_user_connection_id);
  } else {
    src = await deps.resolveSelfLogged(identity, spec.kind);
  }
  if (!src.ok) {
    await reportFailure(deps, writer, src.code);
    return { ok: false, code: src.code };
  }

  // 4. the store write (consent is checked inside, per sample category).
  const res = await deps.write({
    identity: { tenant_id: identity.tenant_id, user_id: identity.user_id },
    source_id: src.source_id,
    batch_id: deps.newId(),
    via: 'internal',
    tz: 'UTC',
    samples,
    deletions,
  });
  if (!res.ok) {
    await reportFailure(deps, writer, res.code);
    return { ok: false, code: res.code };
  }
  const counts: Partial<Record<HealthSampleStatus, number>> = {};
  for (const r of res.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  for (const [status, n] of Object.entries(counts)) count(`${writer}:${status}`, n);
  const notStored = (counts.quarantined ?? 0) + (counts.invalid ?? 0) + (counts.skipped_no_consent ?? 0) + (counts.store_unavailable ?? 0);
  if (notStored > 0) {
    const reasons: Record<string, number> = {};
    for (const r of res.results) {
      if (r.status === 'quarantined' || r.status === 'invalid' || r.status === 'skipped_no_consent' || r.status === 'store_unavailable') {
        const k = r.code ?? r.status;
        reasons[k] = (reasons[k] ?? 0) + 1;
      }
    }
    safeLog(deps, { event: 'health_store_dual_write_partial', writer, counts, reasons });
    if ((counts.store_unavailable ?? 0) > 0) await reportFailure(deps, writer, 'STORE_UNAVAILABLE', { items: counts.store_unavailable });
    if (cutover) {
      // S3: non-stored statuses are fatal in derived mode.
      const code = Object.keys(reasons).sort()[0] ?? 'NOT_STORED';
      await reportFailure(deps, writer, `CUTOVER_${code}`);
      return { ok: false, code };
    }
  }

  // 5. pending markers for the member-days that changed, before the caller responds.
  const changed = new Set<string>();
  res.results.forEach((r, i) => {
    if ((r.status === 'stored' || r.status === 'updated' || r.status === 'deleted') && itemDates[i]) changed.add(itemDates[i]);
  });
  // In cutover mode every item date is derived (a duplicate still needs its live row).
  const dates = cutover ? Array.from(new Set(itemDates.filter(Boolean))).sort() : Array.from(changed).sort();
  if (dates.length === 0) return { ok: true, counts, dates, marker: 'none' };

  const enqueuedAt = deps.now().toISOString();
  const marker = await deps.repo.upsertPending(dates.map((date) => ({ tenant_id: identity.tenant_id, user_id: identity.user_id, date, enqueued_at: enqueuedAt })));
  if (marker.error) {
    // Counted, never fatal: the nightly "previous 2 days" pass still covers the day.
    count(`${writer}:MARKER_WRITE_FAILED`);
    safeLog(deps, { event: 'health_features_marker_write_failed', writer, code: featuresErrorCode(marker.error) });
  }

  const ident = { tenant_id: identity.tenant_id, user_id: identity.user_id };
  // 6a. VTID-05163 cutover: derive and publish NOW, before the caller's Index recompute; a failure is the caller's.
  if (cutover) {
    const d = await deriveAndStore(deps.derivation, ident, dates, 'live');
    if (!d.ok) {
      count(`${writer}:DERIVATION_${d.code}`);
      await reportFailure(deps, writer, `DERIVATION_${d.code}`);
      return { ok: false, code: `DERIVATION_${d.code}` };
    }
    return { ok: true, counts, dates, marker: marker.error ? 'failed' : 'written' };
  }

  // 6. derivation after the response (target 'live' once a cutover mode is on, so published rows stay in step).
  deps.schedule(async () => {
    const d = await deriveAndStore(deps.derivation, ident, dates, derivationTargetFor(deps.derivation.env));
    if (!d.ok) {
      count(`${writer}:DERIVATION_${d.code}`);
      safeLog(deps, { event: 'health_features_derivation_failed', writer, code: d.code });
    }
  });
  return { ok: true, counts, dates, marker: marker.error ? 'failed' : 'written' };
}
