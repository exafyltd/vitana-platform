/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S10: the in-memory Jest fake of the
 * health store (S2–S5 and S8), for B's and C's tests and for A's own suites.
 *
 *   const store = createFakeHealthStore();
 *   const src = store.addSource({ tenant_id, user_id, kind: 'phone_store', connector_id: 'apple_health' });
 *   store.grantConsent({ tenant_id, user_id }, 'wearables', 'oura');
 *   await store.writeHealthSamples(sb, {...});        // S3, same signature
 *   await store.readDailyObservations(sb, identity, {...});   // S4
 *   store.registerHealthStoreChangeHook(fn);           // S8 (fake-local registry)
 *
 * The ports run the REAL store logic (ingest.ts / reader.ts / suppression.ts)
 * over in-memory parts: createMemoryHealthStoreRepository() implements the
 * repository interface with the A1 SQL functions' semantics (replace upsert,
 * duplicate / updated / deleted / not_found / suppressed, 5-minute vs hourly
 * tier at 30 days, hourly + daily rollups in the call's time zone, records by
 * (source_id, source_record_id)), and memoryRawBatchStore() stands in for the
 * S3 bucket. Sources (S6) and consents (D10) are in-memory tables the test
 * fills. Nothing here touches a network or a database.
 *
 * A shape change in S2–S5/S8 is made in the Shared interfaces section first,
 * then here; consumers catch it through this fake, never through A's internals.
 */

import { randomUUID } from 'crypto';
import type { CicdOasisEvent } from '../../../types/cicd';
import type { HealthConsentCategoryKey } from '../../consent/health-consent';
import { HEALTH_CODES, healthCodeById, type HealthDataCategory } from '../catalogue';
import { createHealthStoreHookRegistry, type HealthStoreChangeHook, type HealthStoreIdentity } from '../change-hook';
import type { HealthStoreStatus } from '../flags';
import type {
  BatchRow,
  HealthStoreRepository,
  IngestChunkParams,
  IngestChunkResult,
  ObservationRow,
  QuarantineRow,
  RepoError,
  RepoResult,
  SeriesDailyRow,
  SeriesRow,
} from '../health-store-repository';
import {
  reprocessHealthBatchWith,
  writeHealthSamplesWith,
  type HealthStoreDeps,
  type WriteHealthSamplesInput,
} from '../ingest';
import {
  readDailyObservationsWith,
  readHourlyWith,
  readRecordsWith,
  readSeries5mWith,
  type ReadDailyObservationsOptions,
  type ReadRangeOptions,
} from '../reader';
import { suppressHealthDataWith, unsuppressHealthDataWith, type SuppressionInput } from '../suppression';
import type { RawBatchStore } from '../raw-batch-store';
import { HEALTH_STORE_TABLES } from '../tables';

export { HEALTH_STORE_TABLES, HEALTH_CODES };

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Time-zone helpers (the SQL's AT TIME ZONE, in JS)
// ---------------------------------------------------------------------------

function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a local date starts in `tz`. */
function zonedMidnight(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
}

// ---------------------------------------------------------------------------
// In-memory database + repository
// ---------------------------------------------------------------------------

interface SeriesCell {
  tenant_id: string;
  user_id: string;
  source_id: string;
  source_kind: string;
  source_rank: number;
  code_id: number;
  bucket_start: string;
  n: number | null;
  sum: number | null;
  min: number | null;
  max: number | null;
  consent_id: string | null;
  batch_id: string;
  ingested_at: string;
  suppressed_at: string | null;
}

interface DailyCell extends Omit<SeriesCell, 'bucket_start'> {
  local_date: string;
  tz: string;
}

interface ObservationCell extends Omit<ObservationRow, 'value'> {
  tenant_id: string;
  user_id: string;
  value: number | null;
  consent_id: string | null;
  batch_id: string;
  suppressed_at: string | null;
}

export interface MemoryHealthDb {
  s5m: Map<string, SeriesCell>;
  s1h: Map<string, SeriesCell>;
  s1d: Map<string, DailyCell>;
  obs: Map<string, ObservationCell>;
  batches: BatchRow[];
  quarantine: QuarantineRow[];
  maintenanceRuns: number;
  /** Every method answers 42P01 (store not applied) while true. */
  missing: boolean;
  /** ingestChunk answers 23514 until ensurePartitions runs. */
  partitionsMissing: boolean;
  /** ingestChunk answers 23514 even after ensurePartitions. */
  partitionsBroken: boolean;
  /** Per-method injected error, or a throw ('throw'). */
  fail: Partial<Record<keyof HealthStoreRepository, RepoError | 'throw'>>;
  /** Call log: method name per call. */
  calls: Array<keyof HealthStoreRepository>;
  clock: () => Date;
}

export function createMemoryHealthDb(clock: () => Date = () => new Date()): MemoryHealthDb {
  return {
    s5m: new Map(),
    s1h: new Map(),
    s1d: new Map(),
    obs: new Map(),
    batches: [],
    quarantine: [],
    maintenanceRuns: 0,
    missing: false,
    partitionsMissing: false,
    partitionsBroken: false,
    fail: {},
    calls: [],
    clock,
  };
}

const MISSING: RepoError = { code: '42P01', message: 'relation "public.health_ingest_batches" does not exist' };
const NO_PARTITION: RepoError = { code: '23514', message: 'no partition of relation "health_series_5m" found for row' };

const sKey = (u: string, s: string, c: number, b: string) => `${u}|${s}|${c}|${b}`;
const oKey = (u: string, s: string, r: string) => `${u}|${s}|${r}`;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function createMemoryHealthStoreRepository(db: MemoryHealthDb): HealthStoreRepository {
  async function guard<T>(name: keyof HealthStoreRepository, run: () => T | Promise<T>): RepoResult<T> {
    db.calls.push(name);
    const f = db.fail[name];
    if (f === 'throw') throw new Error(`injected throw: ${name}`);
    if (f) return { data: null, error: f };
    if (db.missing) return { data: null, error: MISSING };
    return { data: await run(), error: null };
  }

  function ingest(p: IngestChunkParams): IngestChunkResult {
    const nowMs = db.clock().getTime();
    const cut = nowMs - 30 * DAY_MS;
    const tz = p.tz || 'UTC';
    const counts: Record<string, number> = {};
    const seriesOut: Array<{ i: number; status: string }> = [];
    const recordsOut: Array<{ i: number; status: string }> = [];
    const hours = new Set<string>();
    const dates = new Set<string>();
    const deleted = new Set<string>();
    const bump = (s: string) => (counts[s] = (counts[s] ?? 0) + 1);
    const ingestedAt = new Date(nowMs).toISOString();

    p.series.forEach((item, i) => {
      let status: string | null = null;
      const code = healthCodeById(Number(item.code_id));
      const startMs = typeof item.bucket_start === 'string' ? Date.parse(item.bucket_start) : NaN;
      if (!code || (code.kind !== 'series_sum' && code.kind !== 'series_stats') || !Number.isFinite(startMs)) status = 'invalid';
      const tier = startMs >= cut ? db.s5m : db.s1h;
      const interval = startMs >= cut ? 5 * 60 * 1000 : HOUR_MS;
      if (!status && startMs % interval !== 0) status = 'invalid';
      const n = num(item.n);
      const sum = num(item.sum);
      const min = num(item.min);
      const max = num(item.max);
      if (!status && [n, sum, min, max].some((v) => Number.isNaN(v))) status = 'invalid';
      if (!status) {
        const bucket = new Date(startMs).toISOString();
        const key = sKey(p.user_id, p.source_id, code!.code_id, bucket);
        const old = tier.get(key);
        if (old && old.suppressed_at) status = 'suppressed';
        else if (item.op === 'delete') {
          if (old) {
            tier.delete(key);
            status = 'deleted';
            deleted.add(localDate(startMs, tz));
          } else status = 'not_found';
        } else if (old && old.n === n && old.sum === sum && old.min === min && old.max === max) status = 'duplicate';
        else {
          tier.set(key, {
            tenant_id: p.tenant_id,
            user_id: p.user_id,
            source_id: p.source_id,
            source_kind: p.source_kind,
            source_rank: p.source_rank,
            code_id: code!.code_id,
            bucket_start: bucket,
            n,
            sum,
            min,
            max,
            consent_id: p.consent_id,
            batch_id: p.batch_id,
            ingested_at: ingestedAt,
            suppressed_at: null,
          });
          status = old ? 'updated' : 'stored';
        }
        if (status === 'stored' || status === 'updated' || status === 'deleted') {
          if (tier === db.s5m) hours.add(`${Math.floor(startMs / HOUR_MS) * HOUR_MS}|${code!.code_id}`);
          dates.add(`${localDate(startMs, tz)}|${code!.code_id}`);
          dates.add(`${localDate(startMs + interval - 1000, tz)}|${code!.code_id}`);
        }
      }
      seriesOut.push({ i, status: status as string });
      bump(status as string);
    });

    // Hourly recompute (hours inside the 5-minute retention).
    for (const h of hours) {
      const [hrStr, codeStr] = h.split('|');
      const hr = Number(hrStr);
      const codeId = Number(codeStr);
      if (hr < cut) continue;
      const rows = Array.from(db.s5m.values()).filter(
        (r) => r.user_id === p.user_id && r.source_id === p.source_id && r.code_id === codeId && !r.suppressed_at && Date.parse(r.bucket_start) >= hr && Date.parse(r.bucket_start) < hr + HOUR_MS,
      );
      const key = sKey(p.user_id, p.source_id, codeId, new Date(hr).toISOString());
      const old = db.s1h.get(key);
      if (old?.suppressed_at) continue;
      if (rows.length === 0) db.s1h.delete(key);
      else db.s1h.set(key, aggregate(p, codeId, new Date(hr).toISOString(), rows, ingestedAt));
    }

    // Daily recompute in the call's time zone.
    for (const d of dates) {
      const [date, codeStr] = d.split('|');
      const codeId = Number(codeStr);
      const dayStart = zonedMidnight(date, tz);
      const src = dayStart >= cut ? db.s5m : db.s1h;
      const rows = Array.from(src.values()).filter(
        (r) => r.user_id === p.user_id && r.source_id === p.source_id && r.code_id === codeId && !r.suppressed_at && localDate(Date.parse(r.bucket_start), tz) === date,
      );
      const key = sKey(p.user_id, p.source_id, codeId, date);
      const old = db.s1d.get(key);
      if (old?.suppressed_at) continue;
      if (rows.length === 0) db.s1d.delete(key);
      else {
        const a = aggregate(p, codeId, '', rows, ingestedAt);
        const { bucket_start: _b, ...rest } = a;
        db.s1d.set(key, { ...rest, local_date: date, tz });
      }
    }

    p.records.forEach((item, i) => {
      let status: string | null = null;
      const rid = typeof item.source_record_id === 'string' ? item.source_record_id : '';
      if (rid.length < 1 || rid.length > 256) status = 'invalid';
      if (!status) {
        const key = oKey(p.user_id, p.source_id, rid);
        const old = db.obs.get(key);
        const code = healthCodeById(Number(item.code_id));
        const startMs = typeof item.effective_start === 'string' ? Date.parse(item.effective_start) : NaN;
        const endMs = typeof item.effective_end === 'string' ? Date.parse(item.effective_end) : null;
        const value = num(item.value);
        const detail = item.detail === undefined || item.detail === null ? null : item.detail;
        if (old && old.suppressed_at) status = 'suppressed';
        else if (item.op === 'delete') {
          if (old) {
            db.obs.delete(key);
            status = 'deleted';
            deleted.add(localDate(Date.parse(old.effective_start), tz));
          } else status = 'not_found';
        } else if (
          !code ||
          code.kind !== 'record' ||
          !Number.isFinite(startMs) ||
          typeof item.unit !== 'string' ||
          (endMs !== null && (!Number.isFinite(endMs) || endMs < startMs)) ||
          Number.isNaN(value)
        ) {
          status = 'invalid';
        } else {
          const startIso = new Date(startMs).toISOString();
          const endIso = endMs === null ? null : new Date(endMs).toISOString();
          const device = typeof item.device === 'string' ? item.device : null;
          if (
            old &&
            old.code_id === code.code_id &&
            old.value === value &&
            old.unit === item.unit &&
            old.effective_start === startIso &&
            old.effective_end === endIso &&
            old.device === device &&
            JSON.stringify(old.detail) === JSON.stringify(detail)
          ) {
            status = 'duplicate';
          } else {
            db.obs.set(key, {
              tenant_id: p.tenant_id,
              user_id: p.user_id,
              source_id: p.source_id,
              source_kind: p.source_kind,
              source_rank: p.source_rank,
              source_record_id: rid,
              code_id: code.code_id,
              value,
              unit: item.unit as string,
              effective_start: startIso,
              effective_end: endIso,
              device,
              detail,
              consent_id: p.consent_id,
              batch_id: p.batch_id,
              ingested_at: ingestedAt,
              suppressed_at: null,
            });
            status = old ? 'updated' : 'stored';
          }
        }
      }
      recordsOut.push({ i, status: status as string });
      bump(status as string);
    });

    return { counts, series: seriesOut, records: recordsOut, deleted_dates: Array.from(deleted).sort() };
  }

  function aggregate(p: IngestChunkParams, codeId: number, bucket: string, rows: SeriesCell[], ingestedAt: string): SeriesCell {
    const ns = rows.map((r) => r.n).filter((v): v is number => v !== null);
    const sums = rows.map((r) => r.sum).filter((v): v is number => v !== null);
    const mins = rows.map((r) => r.min).filter((v): v is number => v !== null);
    const maxs = rows.map((r) => r.max).filter((v): v is number => v !== null);
    return {
      tenant_id: p.tenant_id,
      user_id: p.user_id,
      source_id: p.source_id,
      source_kind: p.source_kind,
      source_rank: p.source_rank,
      code_id: codeId,
      bucket_start: bucket,
      n: ns.length ? ns.reduce((a, b) => a + b, 0) : null,
      sum: sums.length ? sums.reduce((a, b) => a + b, 0) : null,
      min: mins.length ? Math.min(...mins) : null,
      max: maxs.length ? Math.max(...maxs) : null,
      consent_id: p.consent_id,
      batch_id: p.batch_id,
      ingested_at: ingestedAt,
      suppressed_at: null,
    };
  }

  function codesOf(category: string | null): Set<number> {
    return new Set(HEALTH_CODES.filter((c) => category === null || c.category === category).map((c) => c.code_id));
  }

  function setSuppressed(userId: string, category: string | null, sourceId: string | null, at: string | null): Record<string, number> {
    const codes = codesOf(category);
    const out: Record<string, number> = {};
    const tiers: Array<[string, Map<string, { user_id: string; source_id: string; code_id: number; suppressed_at: string | null }>]> = [
      ['health_series_5m', db.s5m],
      ['health_series_1h', db.s1h],
      ['health_series_1d', db.s1d],
      ['health_observations', db.obs],
    ];
    for (const [name, tier] of tiers) {
      let n = 0;
      for (const r of tier.values()) {
        if (r.user_id !== userId || !codes.has(r.code_id) || (sourceId && r.source_id !== sourceId)) continue;
        if (at && !r.suppressed_at) {
          r.suppressed_at = at;
          n++;
        } else if (!at && r.suppressed_at) {
          r.suppressed_at = null;
          n++;
        }
      }
      out[name] = n;
    }
    return out;
  }

  const ownRows = <T extends { tenant_id: string; user_id: string; code_id: number; suppressed_at: string | null }>(
    rows: Iterable<T>,
    tenantId: string,
    userId: string,
    codeIds: number[],
  ) => Array.from(rows).filter((r) => r.tenant_id === tenantId && r.user_id === userId && codeIds.includes(r.code_id) && !r.suppressed_at);

  return {
    findBatch: (userId, batchId, sinceIso) =>
      guard('findBatch', () =>
        db.batches
          .filter((b) => b.user_id === userId && b.batch_id === batchId && b.received_at >= sinceIso)
          .sort((a, b) => (a.received_at < b.received_at ? 1 : -1))[0] ?? null,
      ),
    findBatchById: (batchId, sinceIso) =>
      guard('findBatchById', () => db.batches.filter((b) => b.batch_id === batchId && b.received_at >= sinceIso).slice(-1)[0] ?? null),
    listBatchCountsSince: (userId, sinceIso) =>
      guard('listBatchCountsSince', () =>
        db.batches
          .filter((b) => b.user_id === userId && b.received_at >= sinceIso)
          .map((b) => ({ accepted: b.accepted, quarantined: b.quarantined, rejected: b.rejected })),
      ),
    firstBatchForSource: (userId, sourceId, sinceIso) =>
      guard('firstBatchForSource', () => {
        const rows = db.batches.filter((b) => b.user_id === userId && b.source_id === sourceId && b.received_at >= sinceIso).sort((a, b) => (a.received_at < b.received_at ? -1 : 1));
        return rows[0] ? { received_at: rows[0].received_at } : null;
      }),
    insertBatch: (row) =>
      guard('insertBatch', () => {
        const month = row.received_at.slice(0, 7);
        if (db.batches.some((b) => b.user_id === row.user_id && b.batch_id === row.batch_id && b.received_at.slice(0, 7) === month)) {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        db.batches.push({ ...row });
        return null;
      }).catch((err: { code?: string }) => ({ data: null, error: { code: err?.code ?? 'EXCEPTION', message: 'insert failed' } })),
    insertQuarantine: (rows) =>
      guard('insertQuarantine', () => {
        db.quarantine.push(...rows.map((r) => ({ ...r })));
        return null;
      }),
    ingestChunk: (params) =>
      guard('ingestChunk', () => {
        if (db.partitionsMissing || db.partitionsBroken) throw Object.assign(new Error('no partition'), { repo: NO_PARTITION });
        return ingest(params);
      }).catch((err: { repo?: RepoError; message?: string }) => {
        if (err?.repo) return { data: null, error: err.repo };
        throw err;
      }),
    ensurePartitions: (_nowIso) =>
      guard('ensurePartitions', () => {
        const created = db.partitionsMissing ? 1 : 0;
        db.partitionsMissing = false;
        return created;
      }),
    partitionCheck: (nowIso) =>
      guard('partitionCheck', () => {
        if (!db.partitionsMissing && !db.partitionsBroken) return [];
        const tomorrow = new Date(Date.parse(nowIso) + DAY_MS).toISOString().slice(0, 10);
        return [{ parent: 'health_series_5m', partition_name: `health_series_5m_p${tomorrow.replace(/-/g, '')}`, for_date: tomorrow }];
      }),
    purge: (nowIso) =>
      guard('purge', () => {
        const now = Date.parse(nowIso);
        const cut = now - 30 * DAY_MS;
        const suppCut = now - 7 * DAY_MS;
        const before = db.batches.length;
        db.batches = db.batches.filter((b) => Date.parse(b.received_at) >= cut);
        let rows = before - db.batches.length;
        for (const [k, r] of db.s5m) if (Date.parse(r.bucket_start) + DAY_MS < cut) db.s5m.delete(k);
        for (const tier of [db.s5m, db.s1h, db.s1d, db.obs] as Array<Map<string, { suppressed_at: string | null }>>) {
          for (const [k, r] of tier) {
            if (r.suppressed_at && Date.parse(r.suppressed_at) < suppCut) {
              tier.delete(k);
              rows++;
            }
          }
        }
        db.maintenanceRuns++;
        return { run_id: randomUUID(), partitions_dropped: 0, rows_purged: rows };
      }),
    suppress: (userId, category, sourceId, atIso) => guard('suppress', () => setSuppressed(userId, category, sourceId, atIso)),
    unsuppress: (userId, category, sourceId) => guard('unsuppress', () => setSuppressed(userId, category, sourceId, null)),
    readSeriesDaily: (tenantId, userId, codeIds, from, to) =>
      guard('readSeriesDaily', () =>
        ownRows(db.s1d.values(), tenantId, userId, codeIds)
          .filter((r) => r.local_date >= from && r.local_date <= to)
          .map(
            (r): SeriesDailyRow => ({
              source_id: r.source_id,
              source_kind: r.source_kind,
              source_rank: r.source_rank,
              code_id: r.code_id,
              local_date: r.local_date,
              tz: r.tz,
              n: r.n,
              sum: r.sum,
              min: r.min,
              max: r.max,
              ingested_at: r.ingested_at,
            }),
          ),
      ),
    readSeries: (tier, tenantId, userId, codeIds, fromIso, toIso) =>
      guard('readSeries', () =>
        ownRows((tier === '5m' ? db.s5m : db.s1h).values(), tenantId, userId, codeIds)
          .filter((r) => r.bucket_start >= fromIso && r.bucket_start < toIso)
          .sort((a, b) => (a.bucket_start < b.bucket_start ? -1 : 1))
          .map(
            (r): SeriesRow => ({
              source_id: r.source_id,
              source_kind: r.source_kind,
              source_rank: r.source_rank,
              code_id: r.code_id,
              bucket_start: r.bucket_start,
              n: r.n,
              sum: r.sum,
              min: r.min,
              max: r.max,
              ingested_at: r.ingested_at,
            }),
          ),
      ),
    readObservations: (tenantId, userId, codeIds, fromIso, toIso) =>
      guard('readObservations', () =>
        ownRows(db.obs.values(), tenantId, userId, codeIds)
          .filter((r) => r.effective_start >= fromIso && r.effective_start < toIso)
          .sort((a, b) => (a.effective_start < b.effective_start ? -1 : 1))
          .map(
            (r): ObservationRow => ({
              source_id: r.source_id,
              source_kind: r.source_kind,
              source_rank: r.source_rank,
              source_record_id: r.source_record_id,
              code_id: r.code_id,
              value: r.value,
              unit: r.unit,
              effective_start: r.effective_start,
              effective_end: r.effective_end,
              device: r.device,
              detail: r.detail,
              ingested_at: r.ingested_at,
            }),
          ),
      ),
    capacitySnapshot: () => guard('capacitySnapshot', () => ({ series_5m_rows_estimate: db.s5m.size, connected_device_sources: null })),
  };
}

// ---------------------------------------------------------------------------
// In-memory raw-batch bucket
// ---------------------------------------------------------------------------

export interface MemoryRawBatchStore extends RawBatchStore {
  objects: Map<string, unknown>;
  failPut: boolean;
  failErase: boolean;
  puts: number;
}

export function memoryRawBatchStore(): MemoryRawBatchStore {
  const store: MemoryRawBatchStore = {
    objects: new Map(),
    failPut: false,
    failErase: false,
    puts: 0,
    async put(key, payload) {
      store.puts++;
      if (store.failPut) return { ok: false, code: 'STORE_UNAVAILABLE' };
      store.objects.set(key, JSON.parse(JSON.stringify(payload)));
      return { ok: true };
    },
    async get(key) {
      return { ok: true, payload: store.objects.has(key) ? JSON.parse(JSON.stringify(store.objects.get(key))) : null };
    },
    async delete(key) {
      store.objects.delete(key);
      return { ok: true };
    },
    async erasePrefix(prefix) {
      if (store.failErase) return { ok: false, code: 'STORE_UNAVAILABLE' };
      let deleted = 0;
      for (const k of Array.from(store.objects.keys())) {
        if (k.startsWith(prefix)) {
          store.objects.delete(k);
          deleted++;
        }
      }
      const residual = Array.from(store.objects.keys()).filter((k) => k.startsWith(prefix)).length;
      return { ok: true, deleted, residual };
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// The fake store (S10)
// ---------------------------------------------------------------------------

export interface FakeHealthSource {
  source_id: string;
  tenant_id: string;
  user_id: string;
  kind: 'device_cloud' | 'aggregator' | 'phone_store' | 'partner' | 'manual' | 'voice' | 'diary';
  connector_id: string | null;
  status: 'pending' | 'connected' | 'paused' | 'disconnected' | 'error';
}

export interface FakeHealthStoreOptions {
  clock?: () => Date;
  enabled?: boolean;
}

export function createFakeHealthStore(opts: FakeHealthStoreOptions = {}) {
  const clock = opts.clock ?? (() => new Date());
  const db = createMemoryHealthDb(clock);
  const repo = createMemoryHealthStoreRepository(db);
  const raw = memoryRawBatchStore();
  const hooks = createHealthStoreHookRegistry();
  const sources = new Map<string, FakeHealthSource>();
  const consents = new Map<string, string>();
  const events: CicdOasisEvent[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let status: HealthStoreStatus = opts.enabled === false ? { enabled: false, reason: 'flag_off' } : { enabled: true, reason: null };
  let consentReads = 0;
  const consentKey = (i: HealthStoreIdentity, key: string, resource?: string | null) => `${i.tenant_id}|${i.user_id}|${key}|${resource ?? ''}`;

  const deps: HealthStoreDeps = {
    repo,
    raw,
    status: () => status,
    resolveSource: async (identity, sourceId) => {
      const s = sources.get(sourceId);
      if (!s || s.tenant_id !== identity.tenant_id || s.user_id !== identity.user_id) return { ok: false, code: 'SOURCE_NOT_CONNECTED' };
      return { ok: true, source_id: s.source_id, kind: s.kind, connector_id: s.connector_id, status: s.status };
    },
    findConsentId: async (identity, key, resource) => {
      consentReads++;
      return consents.get(consentKey(identity, key, resource)) ?? null;
    },
    hasConsent: async (identity, key, resource) => consents.has(consentKey(identity, key, resource)),
    emit: async (event) => {
      events.push(event);
      return { ok: true };
    },
    hooks,
    now: clock,
    log: (line) => {
      logs.push(line);
    },
  };

  return {
    deps,
    db,
    raw,
    events,
    logs,
    HEALTH_STORE_TABLES,
    HEALTH_CODES,
    setEnabled(on: boolean) {
      status = on ? { enabled: true, reason: null } : { enabled: false, reason: 'flag_off' };
    },
    addSource(s: Omit<FakeHealthSource, 'source_id' | 'status' | 'connector_id'> & Partial<Pick<FakeHealthSource, 'source_id' | 'status' | 'connector_id'>>): string {
      const source_id = s.source_id ?? randomUUID();
      sources.set(source_id, { connector_id: null, status: 'connected', ...s, source_id });
      return source_id;
    },
    /** Grants a D10 consent; returns its id. For keys C1 adds later, pass the key string. */
    grantConsent(identity: HealthStoreIdentity, key: HealthConsentCategoryKey, resource?: string | null): string {
      const id = randomUUID();
      consents.set(consentKey(identity, key, resource), id);
      return id;
    },
    revokeConsent(identity: HealthStoreIdentity, key: HealthConsentCategoryKey, resource?: string | null): void {
      consents.delete(consentKey(identity, key, resource));
    },
    consentReadCount: () => consentReads,
    // ---- ports (same signatures as the real module; `sb` is ignored) ----
    writeHealthSamples: (_sb: unknown, input: WriteHealthSamplesInput) => writeHealthSamplesWith(deps, input),
    readDailyObservations: (_sb: unknown, identity: HealthStoreIdentity, o: ReadDailyObservationsOptions) => readDailyObservationsWith(deps, identity, o),
    readSeries5m: (_sb: unknown, identity: HealthStoreIdentity, o: ReadRangeOptions) => readSeries5mWith(deps, identity, o),
    readHourly: (_sb: unknown, identity: HealthStoreIdentity, o: ReadRangeOptions) => readHourlyWith(deps, identity, o),
    readRecords: (_sb: unknown, identity: HealthStoreIdentity, o: ReadRangeOptions) => readRecordsWith(deps, identity, o),
    suppressHealthData: (_sb: unknown, identity: HealthStoreIdentity, input?: SuppressionInput) => suppressHealthDataWith(deps, identity, input),
    unsuppressHealthData: (_sb: unknown, identity: HealthStoreIdentity, input?: Omit<SuppressionInput, 'at'>) => unsuppressHealthDataWith(deps, identity, input),
    reprocessHealthBatch: (_sb: unknown, batchId: string) => reprocessHealthBatchWith(deps, batchId),
    registerHealthStoreChangeHook: (fn: HealthStoreChangeHook) => hooks.register(fn),
    flushHooks: () => hooks.flush(),
  };
}

export type FakeHealthStore = ReturnType<typeof createFakeHealthStore>;
export type { HealthDataCategory };
