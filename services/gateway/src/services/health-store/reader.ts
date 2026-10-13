/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S4: reads from the health store.
 *
 *   readDailyObservations(sb, identity, { codes, from, to, purpose, tz? })
 *     -> { ok:true, rows:[{ date, code, value, unit, sample_count, updated_at,
 *                           sources:[{ source_id, source_kind, value, sample_count }] }] }
 *      | { ok:false, code:'consent_required'|'PURPOSE_REQUIRED'|'STORE_DISABLED'|'STORE_PENDING'|'STORE_UNAVAILABLE'|'INVALID_INPUT' }
 *   readSeries5m / readHourly / readRecords — the same purpose rule.
 *
 * - `purpose` is mandatory, with no default: missing -> PURPOSE_REQUIRED and
 *   the repository is not called.
 * - I5: `ai_context` requires `ai_health_analysis` through hasHealthConsent,
 *   fail closed (`consent_required`, repository not called). `member_view` and
 *   `feature_compute` need no extra check: ingest consent already gated the data.
 * - Suppressed rows are never returned (every query filters suppressed_at IS NULL).
 * - `date` is the member's local date: series codes use the daily tier
 *   (attributed at ingest with the batch's tz); record codes are attributed to
 *   the local date of their start in `tz` (default UTC; B2/C2 pass the
 *   member's zone).
 * - `value` is the code's daily rule (dailyRuleOf) from the best-ranked source
 *   (smallest source_rank, newest ingest on a tie); `sources` carries every
 *   contributor's own value so a consumer can apply its own precedence.
 * Commerce modules may not import this module (vtid-05025 boundary test).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { healthCodeById, healthCodeByKey, isSeriesKind, type HealthCode, type HealthDailyRule } from './catalogue';
import type { HealthStoreIdentity } from './change-hook';
import { defaultHealthStoreDeps, isValidTimeZone, storeErrorCode, type HealthStoreDeps } from './ingest';
import type { ObservationRow, SeriesRow } from './health-store-repository';

export const HEALTH_READ_PURPOSES = ['member_view', 'feature_compute', 'ai_context'] as const;
export type HealthReadPurpose = (typeof HEALTH_READ_PURPOSES)[number];

export type HealthReadErrorCode =
  | 'consent_required'
  | 'PURPOSE_REQUIRED'
  | 'STORE_DISABLED'
  | 'STORE_PENDING'
  | 'STORE_UNAVAILABLE'
  | 'INVALID_INPUT';

export interface DailyObservationSource {
  source_id: string;
  source_kind: string;
  value: number | null;
  sample_count: number;
}

export interface DailyObservationRow {
  date: string;
  code: string;
  value: number | null;
  unit: string;
  sample_count: number;
  updated_at: string;
  sources: DailyObservationSource[];
}

export interface ReadDailyObservationsOptions {
  codes: string[];
  from: string;
  to: string;
  purpose: HealthReadPurpose;
  /** IANA zone for attributing record codes to a local date (default UTC). */
  tz?: string;
}

export type ReadDailyObservationsResult = { ok: true; rows: DailyObservationRow[] } | { ok: false; code: HealthReadErrorCode };

export interface ReadRangeOptions {
  codes: string[];
  /** ISO timestamps, [from, to). */
  from: string;
  to: string;
  purpose: HealthReadPurpose;
}

export interface SeriesPoint {
  bucket_start: string;
  code: string;
  unit: string;
  n: number | null;
  sum: number | null;
  min: number | null;
  max: number | null;
  source_id: string;
  source_kind: string;
}

export interface RecordPoint {
  source_record_id: string;
  code: string;
  unit: string;
  value: number | null;
  start: string;
  end: string | null;
  device: string | null;
  detail: unknown;
  source_id: string;
  source_kind: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const MAX_CODES = 50;

function isPurpose(p: unknown): p is HealthReadPurpose {
  return typeof p === 'string' && (HEALTH_READ_PURPOSES as readonly string[]).includes(p);
}

function validIdentity(i: HealthStoreIdentity | null | undefined): boolean {
  return !!i && typeof i.tenant_id === 'string' && i.tenant_id.length > 0 && typeof i.user_id === 'string' && i.user_id.length > 0;
}

/** Purpose -> flag -> identity -> I5 consent. Null = may read. */
async function gate(
  deps: HealthStoreDeps,
  identity: HealthStoreIdentity,
  purpose: unknown,
): Promise<{ ok: false; code: HealthReadErrorCode } | null> {
  if (!isPurpose(purpose)) return { ok: false, code: 'PURPOSE_REQUIRED' };
  if (!deps.status().enabled) return { ok: false, code: 'STORE_DISABLED' };
  if (!validIdentity(identity)) return { ok: false, code: 'INVALID_INPUT' };
  if (purpose === 'ai_context') {
    let granted = false;
    try {
      granted = (await deps.hasConsent(identity, 'ai_health_analysis')) === true;
    } catch {
      granted = false;
    }
    if (!granted) return { ok: false, code: 'consent_required' };
  }
  return null;
}

function knownCodes(codes: unknown): HealthCode[] | null {
  if (!Array.isArray(codes) || codes.length > MAX_CODES) return null;
  const out: HealthCode[] = [];
  for (const k of codes) {
    if (typeof k !== 'string') return null;
    const c = healthCodeByKey(k);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export function localDateOf(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function applyRule(rule: HealthDailyRule, values: number[]): number | null {
  if (values.length === 0) return null;
  switch (rule) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'last':
      return values[values.length - 1];
  }
}

function seriesDailyValue(rule: HealthDailyRule, r: { n: number | null; sum: number | null; min: number | null; max: number | null }): number | null {
  switch (rule) {
    case 'sum':
      return r.sum;
    case 'min':
      return r.min;
    case 'max':
      return r.max;
    default:
      return r.sum !== null && r.n !== null && r.n > 0 ? r.sum / r.n : null;
  }
}

interface Contribution {
  source_id: string;
  source_kind: string;
  source_rank: number;
  value: number | null;
  sample_count: number;
  ingested_at: string;
}

export async function readDailyObservationsWith(
  deps: HealthStoreDeps,
  identity: HealthStoreIdentity,
  opts: ReadDailyObservationsOptions,
): Promise<ReadDailyObservationsResult> {
  try {
    const blocked = await gate(deps, identity, opts?.purpose);
    if (blocked) return blocked;
    const codes = knownCodes(opts.codes);
    const tz = opts.tz ?? 'UTC';
    if (!codes || typeof opts.from !== 'string' || typeof opts.to !== 'string' || !DATE_RE.test(opts.from) || !DATE_RE.test(opts.to) || !isValidTimeZone(tz)) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    const fromMs = Date.parse(`${opts.from}T00:00:00Z`);
    const toMs = Date.parse(`${opts.to}T00:00:00Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    if (codes.length === 0) return { ok: true, rows: [] };

    const cells = new Map<string, { date: string; code: HealthCode; contributions: Contribution[] }>();
    const cell = (date: string, code: HealthCode) => {
      const k = `${date}|${code.code_id}`;
      let c = cells.get(k);
      if (!c) {
        c = { date, code, contributions: [] };
        cells.set(k, c);
      }
      return c;
    };

    const seriesCodes = codes.filter((c) => isSeriesKind(c.kind));
    const recordCodes = codes.filter((c) => !isSeriesKind(c.kind));

    if (seriesCodes.length > 0) {
      const res = await deps.repo.readSeriesDaily(identity.tenant_id, identity.user_id, seriesCodes.map((c) => c.code_id), opts.from, opts.to);
      if (res.error) return { ok: false, code: storeErrorCode(res.error) };
      for (const r of res.data ?? []) {
        const code = healthCodeById(r.code_id);
        if (!code) continue;
        cell(String(r.local_date).slice(0, 10), code).contributions.push({
          source_id: r.source_id,
          source_kind: r.source_kind,
          source_rank: r.source_rank,
          value: seriesDailyValue(code.daily_rule, r),
          sample_count: r.n ?? 0,
          ingested_at: r.ingested_at,
        });
      }
    }

    if (recordCodes.length > 0) {
      const res = await deps.repo.readObservations(
        identity.tenant_id,
        identity.user_id,
        recordCodes.map((c) => c.code_id),
        new Date(fromMs - DAY_MS).toISOString(),
        new Date(toMs + 2 * DAY_MS).toISOString(),
      );
      if (res.error) return { ok: false, code: storeErrorCode(res.error) };
      const perSource = new Map<string, { date: string; code: HealthCode; rows: ObservationRow[] }>();
      for (const r of res.data ?? []) {
        const code = healthCodeById(r.code_id);
        if (!code) continue;
        const date = localDateOf(Date.parse(r.effective_start), tz);
        if (date < opts.from || date > opts.to) continue;
        const k = `${date}|${code.code_id}|${r.source_id}`;
        let g = perSource.get(k);
        if (!g) {
          g = { date, code, rows: [] };
          perSource.set(k, g);
        }
        g.rows.push(r);
      }
      for (const g of perSource.values()) {
        const sorted = g.rows.slice().sort((a, b) => Date.parse(a.effective_start) - Date.parse(b.effective_start));
        const values = sorted.map((r) => r.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const head = sorted[0];
        cell(g.date, g.code).contributions.push({
          source_id: head.source_id,
          source_kind: head.source_kind,
          source_rank: Math.min(...sorted.map((r) => r.source_rank)),
          value: applyRule(g.code.daily_rule, values),
          sample_count: sorted.length,
          ingested_at: sorted.map((r) => r.ingested_at).sort().slice(-1)[0],
        });
      }
    }

    const rows: DailyObservationRow[] = [];
    for (const c of cells.values()) {
      const ranked = c.contributions
        .slice()
        .sort((a, b) => a.source_rank - b.source_rank || Date.parse(b.ingested_at) - Date.parse(a.ingested_at) || a.source_id.localeCompare(b.source_id));
      const best = ranked[0];
      rows.push({
        date: c.date,
        code: c.code.key,
        value: best.value,
        unit: c.code.unit,
        sample_count: best.sample_count,
        updated_at: ranked.map((x) => x.ingested_at).sort().slice(-1)[0],
        sources: ranked.map((x) => ({ source_id: x.source_id, source_kind: x.source_kind, value: x.value, sample_count: x.sample_count })),
      });
    }
    rows.sort((a, b) => (a.date === b.date ? a.code.localeCompare(b.code) : a.date < b.date ? -1 : 1));
    return { ok: true, rows };
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

function rangeOk(opts: ReadRangeOptions): { from: number; to: number } | null {
  if (!opts || typeof opts.from !== 'string' || typeof opts.to !== 'string') return null;
  const from = Date.parse(opts.from);
  const to = Date.parse(opts.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_RANGE_DAYS * DAY_MS) return null;
  return { from, to };
}

async function readSeriesTier(
  deps: HealthStoreDeps,
  tier: '5m' | '1h',
  identity: HealthStoreIdentity,
  opts: ReadRangeOptions,
): Promise<{ ok: true; rows: SeriesPoint[] } | { ok: false; code: HealthReadErrorCode }> {
  try {
    const blocked = await gate(deps, identity, opts?.purpose);
    if (blocked) return blocked;
    const codes = knownCodes(opts.codes)?.filter((c) => isSeriesKind(c.kind));
    const range = rangeOk(opts);
    if (!codes || !range) return { ok: false, code: 'INVALID_INPUT' };
    if (codes.length === 0) return { ok: true, rows: [] };
    const res = await deps.repo.readSeries(
      tier,
      identity.tenant_id,
      identity.user_id,
      codes.map((c) => c.code_id),
      new Date(range.from).toISOString(),
      new Date(range.to).toISOString(),
    );
    if (res.error) return { ok: false, code: storeErrorCode(res.error) };
    const rows: SeriesPoint[] = [];
    for (const r of (res.data ?? []) as SeriesRow[]) {
      const code = healthCodeById(r.code_id);
      if (!code) continue;
      rows.push({ bucket_start: r.bucket_start, code: code.key, unit: code.unit, n: r.n, sum: r.sum, min: r.min, max: r.max, source_id: r.source_id, source_kind: r.source_kind });
    }
    return { ok: true, rows };
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

export function readSeries5mWith(deps: HealthStoreDeps, identity: HealthStoreIdentity, opts: ReadRangeOptions) {
  return readSeriesTier(deps, '5m', identity, opts);
}

export function readHourlyWith(deps: HealthStoreDeps, identity: HealthStoreIdentity, opts: ReadRangeOptions) {
  return readSeriesTier(deps, '1h', identity, opts);
}

export async function readRecordsWith(
  deps: HealthStoreDeps,
  identity: HealthStoreIdentity,
  opts: ReadRangeOptions,
): Promise<{ ok: true; rows: RecordPoint[] } | { ok: false; code: HealthReadErrorCode }> {
  try {
    const blocked = await gate(deps, identity, opts?.purpose);
    if (blocked) return blocked;
    const codes = knownCodes(opts.codes)?.filter((c) => !isSeriesKind(c.kind));
    const range = rangeOk(opts);
    if (!codes || !range) return { ok: false, code: 'INVALID_INPUT' };
    if (codes.length === 0) return { ok: true, rows: [] };
    const res = await deps.repo.readObservations(
      identity.tenant_id,
      identity.user_id,
      codes.map((c) => c.code_id),
      new Date(range.from).toISOString(),
      new Date(range.to).toISOString(),
    );
    if (res.error) return { ok: false, code: storeErrorCode(res.error) };
    const rows: RecordPoint[] = [];
    for (const r of (res.data ?? []) as ObservationRow[]) {
      const code = healthCodeById(r.code_id);
      if (!code) continue;
      rows.push({
        source_record_id: r.source_record_id,
        code: code.key,
        unit: r.unit,
        value: r.value,
        start: r.effective_start,
        end: r.effective_end,
        device: r.device,
        detail: r.detail,
        source_id: r.source_id,
        source_kind: r.source_kind,
      });
    }
    return { ok: true, rows };
  } catch {
    return { ok: false, code: 'STORE_UNAVAILABLE' };
  }
}

// ---- S4 entry points over the real store ----------------------------------------

export function readDailyObservations(sb: SupabaseClient, identity: HealthStoreIdentity, opts: ReadDailyObservationsOptions) {
  return readDailyObservationsWith(defaultHealthStoreDeps(sb), identity, opts);
}

export function readSeries5m(sb: SupabaseClient, identity: HealthStoreIdentity, opts: ReadRangeOptions) {
  return readSeries5mWith(defaultHealthStoreDeps(sb), identity, opts);
}

export function readHourly(sb: SupabaseClient, identity: HealthStoreIdentity, opts: ReadRangeOptions) {
  return readHourlyWith(defaultHealthStoreDeps(sb), identity, opts);
}

export function readRecords(sb: SupabaseClient, identity: HealthStoreIdentity, opts: ReadRangeOptions) {
  return readRecordsWith(defaultHealthStoreDeps(sb), identity, opts);
}
