/**
 * VTID-05162 (Health Hub Phase 1 / B2) — B Change 8: derive
 * `health_features_daily_v2` from the health store.
 *
 *   deriveFeatures(dailyObservations) -> DerivedFeature[]      pure, per FEATURE_SPEC
 *   deriveAndStore(deps, identity, dates)                      reads S4, replaces v2 rows
 *   rederiveMemberFeatures(deps, identity, change)             the S8 change hook
 *   registerHealthFeaturesDerivation()                         registers it at startup
 *   runFeatureDerivationCatchUp / runNightlyFeatureDerivation  the nightly passes
 *
 * Rules (plan Change 8):
 *   - Reads go through S4 readDailyObservations with purpose
 *     'feature_compute' (mandatory, no default) and tz 'UTC' — B2 writes every
 *     value anchored at UTC midnight of the legacy row's date, so the store's
 *     local date is the legacy date.
 *   - Value keys (sum / latest): member-stated (manual / voice / diary
 *     sources) over device (the D6a rule); within a class the code order of
 *     the spec, then S4's source ranking. Count keys sum across sources.
 *   - Values outside the spec's bounds (D6a COLUMN_FEATURES for device keys)
 *     are dropped, never clamped. Keys with no code (biomarker_*,
 *     macro_balance, wearable_sleep_stages, wearable_stress, hydration_log,
 *     journal_entry) are never produced.
 *   - deriveAndStore REPLACES the v2 rows of each date it derives: rows the
 *     store no longer supports (deleted or withdrawn data) are deleted. When
 *     the store cannot be read, nothing is written or deleted.
 *   - A successful derivation deletes the member-day's pending marker
 *     (health_features_derivation_pending); the nightly catch-up derives every
 *     marker older than 5 minutes first.
 *   - Nothing a member sees reads health_features_daily_v2 (B3 compares it).
 *     VTID-05163 (B3): once a cutover mode is on (cutover.ts), target 'live'
 *     also publishes the mode's keys for dates >= C into health_features_daily
 *     (metadata.source 'derived_v2', insert-only + update only derived rows,
 *     stale derived rows deleted) — every derivation path (post-write, the
 *     S8 hook, the nightly passes) uses derivationTargetFor(env), so in
 *     `legacy` mode nothing here touches health_features_daily.
 *   - Forced off on staging (shared production database). Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';
import { emitOasisEvent } from '../oasis-event-service';
import { getSupabase } from '../../lib/supabase';
import { registerHealthStoreChangeHook, type HealthStoreChange, type HealthStoreIdentity } from '../health-store/change-hook';
import {
  readDailyObservations,
  type DailyObservationRow,
  type ReadDailyObservationsOptions,
  type ReadDailyObservationsResult,
} from '../health-store/reader';
import {
  DERIVATION_VERSION,
  DERIVED_SOURCE,
  FEATURE_SPEC,
  FEATURE_SPEC_CODES,
  HEALTH_FEATURES_VTID,
} from './feature-spec';
import { isFeatureDerivationEnabled } from './flags';
import { cutoverKeys, derivationTargetFor, getHealthFeaturesCutover } from './cutover';
import {
  featuresErrorCode,
  healthFeaturesRepository,
  type FeatureV2Row,
  type HealthFeaturesRepository,
  type LiveDerivedRow,
} from './health-features-repository';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** S4 allows 400 days per read; derive in windows well inside it. */
const MAX_WINDOW_DAYS = 366;
const SELF_LOGGED_KINDS: ReadonlySet<string> = new Set(['manual', 'voice', 'diary']);
export const DEVICE_CONFIDENCE = 0.9;
export const SELF_LOGGED_CONFIDENCE = 0.85;
export const CATCH_UP_MIN_AGE_MS = 5 * 60 * 1000;
export const CATCH_UP_LIMIT = 500;
export const NIGHTLY_BUDGET_MS = 20_000;

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

export interface DerivedFeature {
  date: string;
  feature_key: string;
  feature_value: number;
  feature_unit: string;
  sample_count: number;
  source_kinds: string[];
  confidence: number;
}

interface Candidate {
  source_kind: string;
  value: number | null;
  sample_count: number;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * S4 daily rows -> Index feature rows, per FEATURE_SPEC. One row per
 * (date, feature_key) that has at least one usable contribution.
 */
export function deriveFeatures(rows: readonly DailyObservationRow[]): DerivedFeature[] {
  const byDateCode = new Map<string, DailyObservationRow>();
  const dates = new Set<string>();
  for (const r of rows ?? []) {
    if (!r || typeof r.date !== 'string' || typeof r.code !== 'string') continue;
    byDateCode.set(`${r.date}|${r.code}`, r);
    dates.add(r.date);
  }
  const out: DerivedFeature[] = [];
  for (const date of Array.from(dates).sort()) {
    for (const spec of FEATURE_SPEC) {
      if (!spec.codes) continue;
      const candidates: Candidate[] = [];
      for (const code of spec.codes) {
        const row = byDateCode.get(`${date}|${code}`);
        if (!row) continue;
        const sources = Array.isArray(row.sources) && row.sources.length > 0
          ? row.sources
          : [{ source_id: '', source_kind: 'unknown', value: row.value, sample_count: row.sample_count }];
        for (const s of sources) candidates.push({ source_kind: String(s.source_kind), value: s.value, sample_count: Number(s.sample_count) || 0 });
      }
      const valid = candidates.filter((c) => {
        if (spec.aggregation === 'count') return c.sample_count > 0;
        if (!finite(c.value)) return false;
        return !spec.bounds || (c.value >= spec.bounds.min && c.value <= spec.bounds.max);
      });
      if (valid.length === 0) continue;
      const sampleCount = valid.reduce((a, c) => a + c.sample_count, 0);
      const kinds = Array.from(new Set(valid.map((c) => c.source_kind))).sort();
      let value: number;
      let selfStated: boolean;
      if (spec.aggregation === 'count') {
        value = sampleCount;
        selfStated = valid.some((c) => SELF_LOGGED_KINDS.has(c.source_kind));
      } else {
        const preferred = valid.find((c) => SELF_LOGGED_KINDS.has(c.source_kind)) ?? valid[0];
        value = preferred.value as number;
        selfStated = SELF_LOGGED_KINDS.has(preferred.source_kind);
      }
      out.push({
        date,
        feature_key: spec.feature_key,
        feature_value: value,
        feature_unit: spec.unit,
        sample_count: sampleCount,
        source_kinds: kinds,
        confidence: selfStated ? SELF_LOGGED_CONFIDENCE : DEVICE_CONFIDENCE,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DerivationDeps {
  read: (identity: HealthStoreIdentity, opts: ReadDailyObservationsOptions) => Promise<ReadDailyObservationsResult>;
  repo: HealthFeaturesRepository;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  emit: (event: CicdOasisEvent) => Promise<unknown>;
  log: (line: Record<string, unknown>) => void;
}

export function defaultDerivationDeps(sb: SupabaseClient): DerivationDeps {
  return {
    read: (identity, opts) => readDailyObservations(sb, identity, opts),
    repo: healthFeaturesRepository(sb),
    now: () => new Date(),
    env: process.env,
    emit: (event) => emitOasisEvent(event),
    log: (line) => console.log(JSON.stringify(line)),
  };
}

function safeLog(deps: DerivationDeps, line: Record<string, unknown>): void {
  try {
    deps.log({ vtid: HEALTH_FEATURES_VTID, ...line });
  } catch {
    /* never throw */
  }
}

function validIdentity(i: HealthStoreIdentity | null | undefined): i is HealthStoreIdentity {
  return !!i && typeof i.tenant_id === 'string' && i.tenant_id.length > 0 && typeof i.user_id === 'string' && i.user_id.length > 0;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Sorted, de-duplicated dates in windows of at most MAX_WINDOW_DAYS. */
function windows(dates: string[]): string[][] {
  const sorted = Array.from(new Set(dates.filter((d) => typeof d === 'string' && DATE_RE.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`))))).sort();
  const out: string[][] = [];
  for (const d of sorted) {
    const cur = out[out.length - 1];
    if (cur && Date.parse(`${d}T00:00:00Z`) - Date.parse(`${cur[0]}T00:00:00Z`) <= (MAX_WINDOW_DAYS - 1) * DAY_MS) cur.push(d);
    else out.push([d]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// deriveAndStore
// ---------------------------------------------------------------------------

export type DerivationErrorCode =
  | 'STAGING'
  | 'INVALID_INPUT'
  | 'consent_required'
  | 'PURPOSE_REQUIRED'
  | 'STORE_DISABLED'
  | 'STORE_PENDING'
  | 'STORE_UNAVAILABLE'
  | 'FEATURES_STORE_PENDING'
  | 'FEATURES_STORE_UNAVAILABLE'
  | 'CUTOVER_OFF'
  | 'THREW';

export type DeriveAndStoreResult =
  | { ok: true; dates: number; upserted: number; deleted: number; published?: number; unpublished?: number }
  | { ok: false; code: DerivationErrorCode };

/**
 * `target` 'v2' (B2): health_features_daily_v2 only. 'live' (VTID-05163, B3
 * cutover): v2 as well, then the cutover mode's keys for dates >= C are
 * published into health_features_daily; 'live' with the switch off answers
 * CUTOVER_OFF and writes nothing.
 */
export async function deriveAndStore(
  deps: DerivationDeps,
  identity: HealthStoreIdentity,
  dates: string[],
  target: 'v2' | 'live' = 'v2',
): Promise<DeriveAndStoreResult> {
  try {
    if (deps.env.VITANA_ENV === 'staging') return { ok: false, code: 'STAGING' };
    if (!validIdentity(identity) || !Array.isArray(dates) || (target !== 'v2' && target !== 'live')) return { ok: false, code: 'INVALID_INPUT' };
    const cutover = getHealthFeaturesCutover(deps.env);
    if (target === 'live' && (cutover.source === 'legacy' || !cutover.cutover_date)) return { ok: false, code: 'CUTOVER_OFF' };
    const liveKeys = new Set(target === 'live' ? cutoverKeys(cutover.source) : []);
    let upserted = 0;
    let deleted = 0;
    let total = 0;
    let published = 0;
    let unpublished = 0;
    for (const win of windows(dates)) {
      const read = await deps.read(identity, {
        codes: [...FEATURE_SPEC_CODES],
        from: win[0],
        to: win[win.length - 1],
        purpose: 'feature_compute',
        tz: 'UTC',
      });
      if (!read.ok) return { ok: false, code: read.code };
      const wanted = new Set(win);
      const derived = deriveFeatures(read.rows).filter((f) => wanted.has(f.date));

      const existing = await deps.repo.listFeaturesV2Keys(identity.tenant_id, identity.user_id, win);
      if (existing.error) return { ok: false, code: featuresErrorCode(existing.error) };

      const nowIso = deps.now().toISOString();
      if (derived.length > 0) {
        const rows: FeatureV2Row[] = derived.map((f) => ({
          tenant_id: identity.tenant_id,
          user_id: identity.user_id,
          date: f.date,
          feature_key: f.feature_key,
          feature_value: f.feature_value,
          feature_unit: f.feature_unit,
          sample_count: f.sample_count,
          confidence: f.confidence,
          metadata: { source: DERIVED_SOURCE, derivation_version: DERIVATION_VERSION, source_kinds: f.source_kinds },
          derivation_version: DERIVATION_VERSION,
          source_kinds: f.source_kinds,
          updated_at: nowIso,
        }));
        const up = await deps.repo.upsertFeaturesV2(rows);
        if (up.error) return { ok: false, code: featuresErrorCode(up.error) };
        upserted += rows.length;
      }

      const keep = new Set(derived.map((f) => `${f.date}|${f.feature_key}`));
      const stale = new Map<string, string[]>();
      for (const r of existing.data ?? []) {
        const date = String(r.date).slice(0, 10);
        if (!wanted.has(date) || keep.has(`${date}|${r.feature_key}`)) continue;
        stale.set(date, [...(stale.get(date) ?? []), r.feature_key]);
      }
      for (const [date, keys] of stale) {
        const del = await deps.repo.deleteFeaturesV2(identity.tenant_id, identity.user_id, date, keys);
        if (del.error) return { ok: false, code: featuresErrorCode(del.error) };
        deleted += keys.length;
      }

      // VTID-05163 (B3): the cutover publish into health_features_daily.
      if (target === 'live' && cutover.cutover_date) {
        const from = cutover.cutover_date;
        const pubDates = win.filter((d) => d >= from);
        if (pubDates.length > 0) {
          const rows: LiveDerivedRow[] = derived
            .filter((f) => f.date >= from && liveKeys.has(f.feature_key))
            .map((f) => ({
              tenant_id: identity.tenant_id,
              user_id: identity.user_id,
              date: f.date,
              feature_key: f.feature_key,
              feature_value: f.feature_value,
              feature_unit: f.feature_unit,
              sample_count: f.sample_count,
              confidence: f.confidence,
              metadata: { source: DERIVED_SOURCE, derivation_version: DERIVATION_VERSION, source_kinds: f.source_kinds },
              updated_at: nowIso,
            }));
          if (rows.length > 0) {
            const ins = await deps.repo.insertLiveIgnoringExisting(rows);
            if (ins.error) return { ok: false, code: featuresErrorCode(ins.error) };
            for (const row of rows) {
              const up = await deps.repo.updateLiveDerivedRow(row);
              if (up.error) return { ok: false, code: featuresErrorCode(up.error) };
            }
            published += rows.length;
          }
          const liveExisting = await deps.repo.listLiveDerivedKeys(identity.tenant_id, identity.user_id, pubDates);
          if (liveExisting.error) return { ok: false, code: featuresErrorCode(liveExisting.error) };
          const pubKeep = new Set(rows.map((r) => `${r.date}|${r.feature_key}`));
          const liveStale = new Map<string, string[]>();
          for (const r of liveExisting.data ?? []) {
            const date = String(r.date).slice(0, 10);
            if (date < from || !liveKeys.has(r.feature_key) || pubKeep.has(`${date}|${r.feature_key}`)) continue;
            liveStale.set(date, [...(liveStale.get(date) ?? []), r.feature_key]);
          }
          for (const [date, keys] of liveStale) {
            const del = await deps.repo.deleteLiveDerived(identity.tenant_id, identity.user_id, date, keys);
            if (del.error) return { ok: false, code: featuresErrorCode(del.error) };
            unpublished += keys.length;
          }
        }
      }

      const cleared = await deps.repo.deletePending(identity.tenant_id, identity.user_id, win);
      if (cleared.error) safeLog(deps, { event: 'health_features_pending_clear_failed', code: featuresErrorCode(cleared.error) });
      total += win.length;
    }
    return target === 'live'
      ? { ok: true, dates: total, upserted, deleted, published, unpublished }
      : { ok: true, dates: total, upserted, deleted };
  } catch {
    return { ok: false, code: 'THREW' };
  }
}

// ---------------------------------------------------------------------------
// S8 change hook
// ---------------------------------------------------------------------------

/**
 * The S8 hook: A fires it after its withdrawal primitives and after any write
 * that deleted rows. Re-derives the affected dates (or, when A names none —
 * a whole-category or whole-source withdrawal — every date the member has v2
 * rows for), which also deletes v2 rows whose observations are gone. Runs
 * whatever the dual-write flags say (a withdrawal must reach derived data);
 * never on staging. Never throws.
 */
export async function rederiveMemberFeatures(
  deps: DerivationDeps,
  identity: HealthStoreIdentity,
  change: HealthStoreChange = {},
): Promise<DeriveAndStoreResult> {
  try {
    if (deps.env.VITANA_ENV === 'staging') return { ok: false, code: 'STAGING' };
    if (!validIdentity(identity)) return { ok: false, code: 'INVALID_INPUT' };
    let dates = Array.isArray(change?.dates) ? change.dates.filter((d) => typeof d === 'string' && DATE_RE.test(d)) : [];
    if (dates.length === 0) {
      const listed = await deps.repo.listFeaturesV2Dates(identity.tenant_id, identity.user_id);
      if (listed.error) {
        const code = featuresErrorCode(listed.error);
        safeLog(deps, { event: 'health_features_rederive_failed', code });
        return { ok: false, code };
      }
      dates = (listed.data ?? []).map((r) => String(r.date).slice(0, 10));
      if (dates.length === 0) return { ok: true, dates: 0, upserted: 0, deleted: 0 };
    }
    const res = await deriveAndStore(deps, identity, dates, derivationTargetFor(deps.env));
    safeLog(deps, res.ok
      ? { event: 'health_features_rederived', dates: res.dates, upserted: res.upserted, deleted: res.deleted }
      : { event: 'health_features_rederive_failed', code: res.code });
    return res;
  } catch {
    return { ok: false, code: 'THREW' };
  }
}

let unregisterHook: (() => void) | null = null;

/**
 * Register rederiveMemberFeatures with A's change hook (S8). Called once at
 * gateway startup; idempotent. A never imports B.
 */
export function registerHealthFeaturesDerivation(
  register: typeof registerHealthStoreChangeHook = registerHealthStoreChangeHook,
  supabase: () => SupabaseClient | null = getSupabase,
): () => void {
  if (unregisterHook) return unregisterHook;
  const off = register(async (identity, change) => {
    const sb = supabase();
    if (!sb) return;
    await rederiveMemberFeatures(defaultDerivationDeps(sb), identity, change);
  });
  unregisterHook = () => {
    off();
    unregisterHook = null;
  };
  return unregisterHook;
}

// ---------------------------------------------------------------------------
// Nightly passes (run from the daily recompute)
// ---------------------------------------------------------------------------

async function emit(deps: DerivationDeps, event: Omit<CicdOasisEvent, 'vtid' | 'source'>): Promise<void> {
  try {
    await deps.emit({ vtid: HEALTH_FEATURES_VTID, source: 'health-features', ...event });
  } catch {
    safeLog(deps, { event: 'health_features_oasis_emit_failed', type: event.type });
  }
}

export interface CatchUpResult {
  skipped?: 'disabled';
  markers_found: number;
  members: number;
  derived_members: number;
  failed_members: number;
}

/**
 * Derive every member-day whose pending marker is older than 5 minutes (a
 * crash between a write's response and its post-response derivation).
 * Emits one OASIS `health.features.derivation_catch_up` with counts only.
 */
export async function runFeatureDerivationCatchUp(
  deps: DerivationDeps,
  opts: { limit?: number; min_age_ms?: number } = {},
): Promise<CatchUpResult> {
  const result: CatchUpResult = { markers_found: 0, members: 0, derived_members: 0, failed_members: 0 };
  try {
    if (!isFeatureDerivationEnabled(deps.env)) return { ...result, skipped: 'disabled' };
    const before = new Date(deps.now().getTime() - (opts.min_age_ms ?? CATCH_UP_MIN_AGE_MS)).toISOString();
    const listed = await deps.repo.listStalePending(before, opts.limit ?? CATCH_UP_LIMIT);
    if (listed.error) {
      safeLog(deps, { event: 'health_features_catch_up_failed', code: featuresErrorCode(listed.error) });
      return result;
    }
    const markers = listed.data ?? [];
    result.markers_found = markers.length;
    const byMember = new Map<string, { identity: HealthStoreIdentity; markers: typeof markers }>();
    for (const m of markers) {
      const k = `${m.tenant_id}|${m.user_id}`;
      const g = byMember.get(k) ?? { identity: { tenant_id: m.tenant_id, user_id: m.user_id }, markers: [] };
      g.markers.push(m);
      byMember.set(k, g);
    }
    result.members = byMember.size;
    for (const g of byMember.values()) {
      const res = await deriveAndStore(deps, g.identity, g.markers.map((m) => String(m.date).slice(0, 10)), derivationTargetFor(deps.env));
      if (res.ok) {
        result.derived_members++;
      } else {
        result.failed_members++;
        for (const m of g.markers) {
          await deps.repo.setPendingAttempts(m.tenant_id, m.user_id, String(m.date).slice(0, 10), (Number(m.attempts) || 0) + 1);
        }
      }
    }
    await emit(deps, {
      type: 'health.features.derivation_catch_up',
      status: result.failed_members > 0 ? 'warning' : 'info',
      message: 'Health features v2 derivation catch-up ran.',
      payload: { markers_found: result.markers_found, members: result.members, derived_members: result.derived_members, failed_members: result.failed_members },
      actor_role: 'system',
      surface: 'system',
    });
    return result;
  } catch {
    return result;
  }
}

export interface NightlyDerivationResult {
  skipped?: 'disabled';
  derived: number;
  failed: number;
  skipped_budget: number;
}

/** The "previous 2 days" pass for one recompute batch's users. Time-capped; never throws. */
export async function runNightlyFeatureDerivation(
  deps: DerivationDeps,
  input: { tenant_id: string; user_ids: string[]; run_date: string; budget_ms?: number },
): Promise<NightlyDerivationResult> {
  const result: NightlyDerivationResult = { derived: 0, failed: 0, skipped_budget: 0 };
  try {
    if (!isFeatureDerivationEnabled(deps.env)) return { ...result, skipped: 'disabled' };
    if (!DATE_RE.test(input.run_date) || !input.tenant_id) return result;
    const dates = [addDays(input.run_date, -2), addDays(input.run_date, -1)];
    const deadline = Date.now() + (input.budget_ms ?? NIGHTLY_BUDGET_MS);
    for (const userId of input.user_ids) {
      if (Date.now() > deadline) {
        result.skipped_budget++;
        continue;
      }
      const res = await deriveAndStore(deps, { tenant_id: input.tenant_id, user_id: userId }, dates, derivationTargetFor(deps.env));
      if (res.ok) result.derived++;
      else result.failed++;
    }
    return result;
  } catch {
    return result;
  }
}
