/**
 * VTID-05163 (Health Hub Phase 1 / B3) — the Vitana Index dual-compute
 * (plan Changes 11–12).
 *
 *   runIndexDualComputeForBatch(deps, batch)   the final step of the existing
 *                                              daily recompute batch
 *   compareMember(deps, input)                 one member: projection x live
 *                                              x row-set diff -> one row per scope
 *   classifyMissing / buildDualComputeReport / evaluateStage   pure
 *
 * Gate: VITANA_INDEX_DUAL_COMPUTE_ENABLED exactly 'true' AND not staging
 * (staging shares the production database). Start dates: D0 =
 * HEALTH_STORE_DUAL_WRITE_DEVICE_SINCE (the day device dual-write was
 * activated), D0s = HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE; no D0 = nothing
 * to compare (skipped 'no_d0').
 *
 * What it reads: the projection (SQL, STABLE), the live vitana_index_scores
 * row the batch's `index` stage just wrote, health_features_daily /
 * health_features_daily_v2 / the legacy shadow (after a cutover) / the
 * pending markers, the member's wearable tables (D6a's own pure mapper ->
 * R_dev, consented providers only), the store through S4 (purpose
 * 'feature_compute') to tell a gap from a failed store write, and B2's
 * in-process dual-write failure counters. What it writes: one
 * vitana_index_dual_compute row per member and scope, and the 120-day purge.
 * It emits no per-member event; the daily OASIS `health.index.dual_compute.report`
 * carries aggregates only. Its own failures never touch the batch's
 * ok / processed / failed / next_cursor. Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CicdOasisEvent } from '../../types/cicd';
import { emitOasisEvent } from '../oasis-event-service';
import { findActiveHealthConsentId, hasHealthConsent } from '../consent/health-consent';
import { categoryOf } from '../health-store/catalogue';
import { consentKeyFor } from '../health-store/consent-gate';
import type { HealthStoreIdentity } from '../health-store/change-hook';
import { readDailyObservations, type ReadDailyObservationsResult } from '../health-store/reader';
import { mapDailyMetricsToFeatures, utcDateOf, type DailyMetricsRow, type WorkoutRow } from '../wearable-features-bridge';
import { getHealthFeaturesCutover } from './cutover';
import {
  DERIVED_FEATURE_KEYS,
  DEVICE_FEATURE_KEYS,
  FEATURE_SPEC,
  FEATURE_SPEC_CODES,
  INDEX_PILLARS,
  featureSpecOf,
} from './feature-spec';
import { getHealthStoreDualWriteCounters } from './record-to-health-store';
import {
  dualComputeErrorCode,
  indexDualComputeRepository,
  type DualComputeReportRow,
  type DualComputeRow,
  type FeatureKeyRow,
  type IndexDualComputeRepository,
  type ProjectionResult,
} from './index-dual-compute-repository';

export const INDEX_DUAL_COMPUTE_VTID = 'VTID-05163';
export const DIFF_WINDOW_DAYS = 90;
export const RETENTION_DAYS = 120;
export const DEFAULT_BATCH_BUDGET_MS = 20_000;
export const REPORT_ROW_LIMIT = 200_000;
/** The baseline-survey writer's rows have no formula sub-scores (F5). */
export const BASELINE_ONLY_MODEL_VERSION = 'baseline-survey-v3-5pillar';

export const DIFF_CLASSES = [
  'consent_withheld',
  'writer_not_rerouted',
  'derivation_pending',
  'derivation_gap',
  'store_write_failed',
  'formula_drift',
  'not_comparable',
] as const;
export type DiffClass = (typeof DIFF_CLASSES)[number];

/** Coded self-logged keys (Stage 2 scope). */
export const SELF_CODED_FEATURE_KEYS: readonly string[] = Object.freeze(
  DERIVED_FEATURE_KEYS.filter((k) => !DEVICE_FEATURE_KEYS.includes(k)),
);
/**
 * metadata.source of the legacy rows written by a re-routed self-logged writer
 * (Change 7): diary, the voice tools, the ORB health tools. W-manual writes no
 * metadata (`{}`), which is matched separately.
 */
export const REROUTED_SELF_LOGGED_SOURCES: readonly string[] = Object.freeze(['diary_extractor', 'voice_tool', 'voice_tool_vitals']);
/** Sources that are not "a writer outside Change 7" for device keys. */
const KNOWN_DEVICE_SOURCES: ReadonlySet<string> = new Set(['wearable_bridge', 'derived_v2', ...REROUTED_SELF_LOGGED_SOURCES]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Flags and dates
// ---------------------------------------------------------------------------

export function isIndexDualComputeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITANA_INDEX_DUAL_COMPUTE_ENABLED === 'true' && env.VITANA_ENV !== 'staging';
}

function validDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
}

/** D0 / D0s — the dual-write activation dates (Change 12). */
export function dualComputeStartDates(env: NodeJS.ProcessEnv = process.env): { d0: string | null; d0s: string | null } {
  const d0 = validDate(env.HEALTH_STORE_DUAL_WRITE_DEVICE_SINCE) ? env.HEALTH_STORE_DUAL_WRITE_DEVICE_SINCE : null;
  const d0s = validDate(env.HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE) ? env.HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE : null;
  return { d0, d0s: d0 ? d0s : null };
}

export function batchBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DUAL_COMPUTE_BATCH_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BATCH_BUDGET_MS;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const maxDate = (a: string, b: string) => (a > b ? a : b);

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DualComputeDeps {
  repo: IndexDualComputeRepository;
  /** S4, purpose 'feature_compute' (the store's daily rows for the diff window). */
  readObservations: (identity: HealthStoreIdentity, from: string, to: string) => Promise<ReadDailyObservationsResult>;
  /** D10 `wearables` consent for one provider (fail closed). */
  hasWearablesConsent: (identity: HealthStoreIdentity, provider: string) => Promise<boolean>;
  /** The S7 key's active consent for the self-logged sources (null key = no consent possible). */
  hasSelfLoggedConsent: (identity: HealthStoreIdentity, category: string) => Promise<boolean>;
  /** B2's in-process per-writer dual-write counters (writer:status|code -> n). */
  dualWriteCounters: () => Record<string, number>;
  emit: (event: CicdOasisEvent) => Promise<unknown>;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  clock: () => number;
  log: (line: Record<string, unknown>) => void;
}

export function defaultDualComputeDeps(sb: SupabaseClient): DualComputeDeps {
  return {
    repo: indexDualComputeRepository(sb),
    readObservations: (identity, from, to) =>
      readDailyObservations(sb, identity, { codes: [...FEATURE_SPEC_CODES], from, to, purpose: 'feature_compute', tz: 'UTC' }),
    hasWearablesConsent: (identity, provider) => hasHealthConsent(sb, identity, 'wearables', provider),
    hasSelfLoggedConsent: async (identity, category) => {
      // Diary / voice / manual share one key (S7): today null until C1's self_logged_health exists.
      const key = consentKeyFor('manual', category as never);
      if (!key) return false;
      return (await findActiveHealthConsentId(sb, identity, key)) !== null;
    },
    dualWriteCounters: () => getHealthStoreDualWriteCounters(),
    emit: (event) => emitOasisEvent(event),
    env: process.env,
    now: () => new Date(),
    clock: () => Date.now(),
    log: (line) => console.log(JSON.stringify(line)),
  };
}

function safeLog(deps: DualComputeDeps, line: Record<string, unknown>): void {
  try {
    deps.log({ vtid: INDEX_DUAL_COMPUTE_VTID, ...line });
  } catch {
    /* never throw */
  }
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

/** Pillars' data + streak sub-scores of a projection (or a live row's feature_inputs.subscores). */
export function pillarsOf(subscores: unknown): Record<string, { data: number; streak: number }> | null {
  if (!subscores || typeof subscores !== 'object') return null;
  const out: Record<string, { data: number; streak: number }> = {};
  for (const p of INDEX_PILLARS) {
    const s = (subscores as Record<string, { data?: unknown; streak?: unknown } | undefined>)[p];
    if (!s) return null;
    out[p] = { data: Number(s.data) || 0, streak: Number(s.streak) || 0 };
  }
  return out;
}

/** The live row is comparable unless it is missing or the F5 baseline-only row. */
export function isLiveComparable(live: { score_total: number | null; model_version: string | null; feature_inputs: Record<string, unknown> | null } | null): boolean {
  if (!live || typeof live.score_total !== 'number') return false;
  if (live.model_version === BASELINE_ONLY_MODEL_VERSION) return false;
  return pillarsOf((live.feature_inputs ?? {})['subscores']) !== null;
}

const sourceOf = (r: FeatureKeyRow): string => {
  const m = r.metadata;
  if (!m || typeof m !== 'object') return '';
  const s = (m as Record<string, unknown>).source;
  return typeof s === 'string' ? s : '';
};
const isEmptyMetadata = (r: FeatureKeyRow) => !r.metadata || (typeof r.metadata === 'object' && Object.keys(r.metadata).length === 0);

/** A legacy self-logged row written by a re-routed writer (Change 11 step 4). */
export function isReroutedSelfLoggedRow(r: FeatureKeyRow): boolean {
  return REROUTED_SELF_LOGGED_SOURCES.includes(sourceOf(r)) || isEmptyMetadata(r);
}

/** R_dev for one member: what the D6a bridge would have written, consented providers only. */
export function buildDeviceReference(
  daily: DailyMetricsRow[],
  workouts: WorkoutRow[],
  consentedProviders: ReadonlySet<string>,
  from: string,
  to: string,
): Set<string> {
  const out = new Set<string>();
  const d = daily.filter((r) => consentedProviders.has(r.provider) && r.metric_date >= from && r.metric_date <= to);
  const w = workouts.filter((r) => consentedProviders.has(r.provider));
  const dates = new Set<string>([...d.map((r) => r.metric_date), ...w.map((r) => utcDateOf(r.started_at) ?? '').filter((x) => x >= from && x <= to)]);
  for (const date of dates) {
    for (const f of mapDailyMetricsToFeatures(d.filter((r) => r.metric_date === date), w.filter((r) => utcDateOf(r.started_at) === date))) {
      out.add(`${date}|${f.feature_key}`);
    }
  }
  return out;
}

export interface MissingContext {
  consented: boolean;
  pending: boolean;
  observed: boolean;
}

/** One (date, key) the reference has and v2 does not (Change 11 step 5). */
export function classifyMissing(ctx: MissingContext): DiffClass {
  if (!ctx.consented) return 'consent_withheld';
  if (ctx.pending) return 'derivation_pending';
  if (ctx.observed) return 'derivation_gap';
  return 'store_write_failed';
}

// ---------------------------------------------------------------------------
// One member
// ---------------------------------------------------------------------------

export interface CompareInput {
  tenant_id: string;
  user_id: string;
  run_date: string;
  d0: string;
  d0s: string | null;
}

type CompareResult = { ok: true; rows: DualComputeRow[] } | { ok: false; code: string; rows: DualComputeRow[] };

function emptyRow(input: CompareInput, scope: 'device' | 'all', nowIso: string): DualComputeRow {
  return {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    date: input.run_date,
    scope,
    live_total: null,
    legacy_total: null,
    v2_total: null,
    legacy_pillars: null,
    v2_pillars: null,
    device_rows_missing: 0,
    device_rows_extra: 0,
    self_rows_missing: 0,
    self_rows_extra: 0,
    diff_class: [],
    formula_ok: null,
    failure_code: null,
    computed_at: nowIso,
  };
}

async function projectOrFail(deps: DualComputeDeps, userId: string, d0: string | null, d0s: string | null): Promise<ProjectionResult | null> {
  const res = await deps.repo.project(userId, d0, d0s);
  if (res.error || !res.data || res.data.ok === false || typeof res.data.score_total !== 'number') return null;
  return res.data;
}

const keyOf = (date: string, key: string) => `${date}|${key}`;

export async function compareMember(deps: DualComputeDeps, input: CompareInput): Promise<CompareResult> {
  const nowIso = deps.now().toISOString();
  const scopes: Array<'device' | 'all'> = input.d0s ? ['device', 'all'] : ['device'];
  const failed = (code: string): CompareResult => ({
    ok: false,
    code,
    rows: scopes.map((s) => ({ ...emptyRow(input, s, nowIso), failure_code: code })),
  });
  try {
    const identity: HealthStoreIdentity = { tenant_id: input.tenant_id, user_id: input.user_id };
    const today = deps.now().toISOString().slice(0, 10);
    const winFrom = addDays(today, -(DIFF_WINDOW_DAYS - 1));

    // 1. projections; 2. the live row.
    const legacyProj = await projectOrFail(deps, input.user_id, null, null);
    if (!legacyProj) return failed('PROJECTION_FAILED');
    const live = await deps.repo.fetchLiveScore(input.tenant_id, input.user_id, input.run_date);
    if (live.error) return failed(dualComputeErrorCode(live.error));
    const comparable = isLiveComparable(live.data);

    // 3./4. inputs of the row-set diff.
    const [v2, legacy, pending] = await Promise.all([
      deps.repo.listV2Rows(input.user_id, winFrom),
      deps.repo.listLegacyRows(input.user_id, winFrom),
      deps.repo.listPendingDates(input.user_id),
    ]);
    if (v2.error) return failed(dualComputeErrorCode(v2.error));
    if (legacy.error) return failed(dualComputeErrorCode(legacy.error));
    if (pending.error) return failed(dualComputeErrorCode(pending.error));
    const pendingDates = new Set((pending.data ?? []).map((r) => String(r.date).slice(0, 10)));
    const v2Keys = new Set((v2.data ?? []).map((r) => keyOf(String(r.date).slice(0, 10), r.feature_key)));

    const obs = await deps.readObservations(identity, winFrom, today);
    if (!obs.ok) return failed(`STORE_READ_${obs.code}`);
    const observed = new Set(obs.rows.filter((r) => Number(r.sample_count) > 0 || r.value !== null).map((r) => keyOf(r.date, r.code)));
    const isObserved = (date: string, key: string) => (featureSpecOf(key)?.codes ?? []).some((c) => observed.has(keyOf(date, c)));

    const rows: DualComputeRow[] = [];
    for (const scope of scopes) {
      const row = emptyRow(input, scope, nowIso);
      const classes = new Set<DiffClass>();
      const proj = await projectOrFail(deps, input.user_id, input.d0, scope === 'all' ? input.d0s : null);
      if (!proj) return failed('PROJECTION_FAILED');
      row.legacy_total = legacyProj.score_total;
      row.v2_total = proj.score_total;
      row.legacy_pillars = pillarsOf(legacyProj.subscores);
      row.v2_pillars = pillarsOf(proj.subscores);
      row.live_total = typeof live.data?.score_total === 'number' ? live.data.score_total : null;

      // Device keys: v2 against R_dev, dates >= D0.
      const devFrom = maxDate(input.d0, winFrom);
      const [daily, workouts] = await Promise.all([
        deps.repo.listDailyMetrics(input.tenant_id, input.user_id, devFrom),
        deps.repo.listWorkouts(input.tenant_id, input.user_id, `${devFrom}T00:00:00.000Z`),
      ]);
      if (daily.error) return failed(dualComputeErrorCode(daily.error));
      if (workouts.error) return failed(dualComputeErrorCode(workouts.error));
      const providers = Array.from(new Set([...(daily.data ?? []).map((r) => r.provider), ...(workouts.data ?? []).map((r) => r.provider)])).sort();
      const consented = new Set<string>();
      for (const p of providers) if (await deps.hasWearablesConsent(identity, p)) consented.add(p);
      const rDev = buildDeviceReference(daily.data ?? [], workouts.data ?? [], consented, devFrom, today);
      const v2Dev = new Set(Array.from(v2Keys).filter((k) => {
        const [date, key] = k.split('|');
        return date >= devFrom && date <= today && DEVICE_FEATURE_KEYS.includes(key);
      }));
      for (const k of rDev) {
        if (v2Dev.has(k)) continue;
        const [date, key] = k.split('|');
        row.device_rows_missing++;
        classes.add(classifyMissing({ consented: true, pending: pendingDates.has(date), observed: isObserved(date, key) }));
      }
      for (const k of v2Dev) {
        if (rDev.has(k)) continue;
        row.device_rows_extra++;
        if (pendingDates.has(k.split('|')[0])) classes.add('derivation_pending');
      }
      // Legacy device-key rows from a writer outside Change 7 (e.g. W-sql).
      if ((legacy.data ?? []).some((r) => {
        const date = String(r.date).slice(0, 10);
        return date >= devFrom && DEVICE_FEATURE_KEYS.includes(r.feature_key) && !KNOWN_DEVICE_SOURCES.has(sourceOf(r)) && !isEmptyMetadata(r);
      })) classes.add('writer_not_rerouted');

      // Self-logged coded keys (scope 'all'): v2 against the re-routed writers' legacy rows, dates >= D0s.
      if (scope === 'all' && input.d0s) {
        const selfFrom = maxDate(input.d0s, winFrom);
        // After a `derived` cutover the legacy role is the shadow for dates >= C (roles swapped).
        const cut = getHealthFeaturesCutover(deps.env);
        let legacyRef: FeatureKeyRow[] = legacy.data ?? [];
        if (cut.source === 'derived' && cut.cutover_date) {
          const shadow = await deps.repo.listShadowRows(input.user_id, selfFrom);
          if (shadow.error) return failed(dualComputeErrorCode(shadow.error));
          const c = cut.cutover_date;
          legacyRef = [...legacyRef.filter((r) => String(r.date).slice(0, 10) < c), ...(shadow.data ?? []).filter((r) => String(r.date).slice(0, 10) >= c)];
        }
        const inScope = legacyRef.filter((r) => String(r.date).slice(0, 10) >= selfFrom && String(r.date).slice(0, 10) <= today);
        const ref = new Set(inScope.filter((r) => SELF_CODED_FEATURE_KEYS.includes(r.feature_key) && isReroutedSelfLoggedRow(r))
          .map((r) => keyOf(String(r.date).slice(0, 10), r.feature_key)));
        if (inScope.some((r) => {
          const spec = featureSpecOf(r.feature_key);
          if (!spec) return false;
          if (spec.codes === null) return true; // biomarker_*, journal_entry, … : never re-routed
          return SELF_CODED_FEATURE_KEYS.includes(r.feature_key) && !isReroutedSelfLoggedRow(r);
        })) classes.add('writer_not_rerouted');
        const v2Self = new Set(Array.from(v2Keys).filter((k) => {
          const [date, key] = k.split('|');
          return date >= selfFrom && date <= today && SELF_CODED_FEATURE_KEYS.includes(key);
        }));
        const consentByCategory = new Map<string, boolean>();
        for (const k of ref) {
          if (v2Self.has(k)) continue;
          const [date, key] = k.split('|');
          row.self_rows_missing++;
          const code = featureSpecOf(key)?.codes?.[0] ?? '';
          const category = categoryOf(code) ?? 'habits';
          if (!consentByCategory.has(category)) consentByCategory.set(category, await deps.hasSelfLoggedConsent(identity, category));
          classes.add(classifyMissing({ consented: consentByCategory.get(category) === true, pending: pendingDates.has(date), observed: isObserved(date, key) }));
        }
        for (const k of v2Self) {
          if (ref.has(k)) continue;
          row.self_rows_extra++;
          if (pendingDates.has(k.split('|')[0])) classes.add('derivation_pending');
        }
      }

      if (!comparable) {
        classes.add('not_comparable');
        row.formula_ok = null;
      } else {
        row.formula_ok = row.live_total === row.legacy_total;
        if (!row.formula_ok) classes.add('formula_drift');
      }
      row.diff_class = DIFF_CLASSES.filter((c) => classes.has(c));
      rows.push(row);
    }
    return { ok: true, rows };
  } catch {
    return failed('THREW');
  }
}

// ---------------------------------------------------------------------------
// The batch step
// ---------------------------------------------------------------------------

export interface DualComputeBatchInput {
  tenant_id: string;
  run_date: string;
  /** The batch's users with whether their `index` stage ended `success` for this run date. */
  users: Array<{ user_id: string; index_ok: boolean }>;
  first_batch: boolean;
}

export interface DualComputeBatchResult {
  skipped?: 'disabled' | 'no_d0' | 'invalid_input';
  compared: number;
  failed: number;
  skipped_budget: number;
  skipped_index: number;
  report_emitted?: boolean;
}

/**
 * The final step of one daily-recompute batch (Change 11). Runs after every
 * user's stages; covers only users whose `index` stage succeeded; capped by
 * DUAL_COMPUTE_BATCH_BUDGET_MS. Never throws.
 */
export async function runIndexDualComputeForBatch(deps: DualComputeDeps, input: DualComputeBatchInput): Promise<DualComputeBatchResult> {
  const result: DualComputeBatchResult = { compared: 0, failed: 0, skipped_budget: 0, skipped_index: 0 };
  try {
    if (!isIndexDualComputeEnabled(deps.env)) return { ...result, skipped: 'disabled' };
    const { d0, d0s } = dualComputeStartDates(deps.env);
    if (!d0) return { ...result, skipped: 'no_d0' };
    if (!input || !validDate(input.run_date) || !input.tenant_id || !Array.isArray(input.users)) return { ...result, skipped: 'invalid_input' };

    if (input.first_batch) {
      const purge = await deps.repo.purgeBefore(addDays(input.run_date, -RETENTION_DAYS));
      if (purge.error) safeLog(deps, { event: 'index_dual_compute_purge_failed', code: dualComputeErrorCode(purge.error) });
      result.report_emitted = await emitDailyReport(deps, addDays(input.run_date, -1));
    }

    const deadline = deps.clock() + batchBudgetMs(deps.env);
    for (const u of input.users) {
      if (!u || !u.index_ok) {
        result.skipped_index++;
        continue;
      }
      if (deps.clock() > deadline) {
        result.skipped_budget++;
        continue;
      }
      const cmp = await compareMember(deps, { tenant_id: input.tenant_id, user_id: u.user_id, run_date: input.run_date, d0, d0s });
      const up = await deps.repo.upsertRows(cmp.rows);
      if (!cmp.ok || up.error) {
        result.failed++;
        safeLog(deps, { event: 'index_dual_compute_member_failed', code: cmp.ok ? dualComputeErrorCode(up.error) : cmp.code });
      } else {
        result.compared++;
      }
    }
    return result;
  } catch {
    return result;
  }
}

// ---------------------------------------------------------------------------
// Report (Change 12) — aggregates only
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export interface DualComputeReport {
  scope: 'device' | 'all';
  from: string;
  to: string;
  member_days: number;
  compared: number;
  job_failures: number;
  /** Δtotal = v2_total − legacy_total (the input switch alone); formula drift is reported separately. */
  delta_total_zero_pct: number | null;
  abs_delta_total: { p50: number | null; p95: number | null; max: number | null };
  diff_class: Record<DiffClass, number>;
  row_mismatches: {
    device_missing: number;
    device_extra: number;
    self_missing: number;
    self_extra: number;
    member_days_device_mismatch: number;
    member_days_self_mismatch: number;
  };
  formula_drift_pct: number | null;
  consent_withheld_impact: { member_days: number; abs_delta_points: number };
  truncated: boolean;
}

export function buildDualComputeReport(rows: DualComputeReportRow[], q: { from: string; to: string; scope: 'device' | 'all' }, truncated = false): DualComputeReport {
  const diff = Object.fromEntries(DIFF_CLASSES.map((c) => [c, 0])) as Record<DiffClass, number>;
  const compared = rows.filter((r) => !r.failure_code);
  const deltas: number[] = [];
  let zero = 0;
  let drift = 0;
  let comparable = 0;
  const withheld = { member_days: 0, abs_delta_points: 0 };
  const mm = { device_missing: 0, device_extra: 0, self_missing: 0, self_extra: 0, member_days_device_mismatch: 0, member_days_self_mismatch: 0 };
  for (const r of compared) {
    for (const c of r.diff_class ?? []) if ((DIFF_CLASSES as readonly string[]).includes(c)) diff[c as DiffClass]++;
    mm.device_missing += r.device_rows_missing;
    mm.device_extra += r.device_rows_extra;
    mm.self_missing += r.self_rows_missing;
    mm.self_extra += r.self_rows_extra;
    if (r.device_rows_missing + r.device_rows_extra > 0) mm.member_days_device_mismatch++;
    if (r.self_rows_missing + r.self_rows_extra > 0) mm.member_days_self_mismatch++;
    if (typeof r.v2_total === 'number' && typeof r.legacy_total === 'number') {
      const d = Math.abs(r.v2_total - r.legacy_total);
      deltas.push(d);
      if (d === 0) zero++;
      if ((r.diff_class ?? []).includes('consent_withheld')) {
        withheld.member_days++;
        withheld.abs_delta_points += d;
      }
    }
    if (r.formula_ok !== null && r.formula_ok !== undefined) {
      comparable++;
      if (!r.formula_ok) drift++;
    }
  }
  deltas.sort((a, b) => a - b);
  return {
    scope: q.scope,
    from: q.from,
    to: q.to,
    member_days: rows.length,
    compared: compared.length,
    job_failures: rows.length - compared.length,
    delta_total_zero_pct: deltas.length ? Math.round((zero / deltas.length) * 10000) / 100 : null,
    abs_delta_total: { p50: percentile(deltas, 50), p95: percentile(deltas, 95), max: deltas.length ? deltas[deltas.length - 1] : null },
    diff_class: diff,
    row_mismatches: mm,
    formula_drift_pct: comparable ? Math.round((drift / comparable) * 10000) / 100 : null,
    consent_withheld_impact: withheld,
    truncated,
  };
}

export interface StageEvaluation {
  stage: 1 | 2;
  start: string | null;
  warmup_end: string | null;
  green_days: number;
  longest_green_run: number;
  formula_drift_pct: number | null;
  met: boolean;
  reasons: string[];
}

export const STAGE_WARMUP_DAYS = 7;
export const STAGE_GREEN_DAYS = 14;
export const STAGE_MAX_FORMULA_DRIFT_PCT = 0.5;

/**
 * Stage 1 (scope 'device', from D0) / Stage 2 (scope 'all', from D0s) —
 * Change 12. A day is green when it has rows, no job failure, no
 * derivation_gap / store_write_failed, and every row-set mismatch of that day
 * is derivation_pending that cleared on the member's next day. Stage 2 adds
 * Δtotal = 0 for every member-day without consent_withheld. Formula drift
 * must stay ≤ 0.5% over the green run.
 */
export function evaluateStage(rows: DualComputeReportRow[], stage: 1 | 2, start: string | null): StageEvaluation {
  const out: StageEvaluation = { stage, start, warmup_end: null, green_days: 0, longest_green_run: 0, formula_drift_pct: null, met: false, reasons: [] };
  if (!start) {
    out.reasons.push(stage === 1 ? 'no_d0' : 'no_d0s');
    return out;
  }
  const warmupEnd = addDays(start, STAGE_WARMUP_DAYS);
  out.warmup_end = warmupEnd;
  const byDate = new Map<string, DualComputeReportRow[]>();
  const byMemberDate = new Map<string, DualComputeReportRow>();
  for (const r of rows) {
    const date = String(r.date).slice(0, 10);
    if (date < warmupEnd) continue;
    byDate.set(date, [...(byDate.get(date) ?? []), r]);
    byMemberDate.set(`${r.user_id}|${date}`, r);
  }
  const mismatch = (r: DualComputeReportRow) =>
    stage === 1 ? r.device_rows_missing + r.device_rows_extra > 0 : r.device_rows_missing + r.device_rows_extra + r.self_rows_missing + r.self_rows_extra > 0;
  const dayGreen = (date: string, dayRows: DualComputeReportRow[]): boolean => {
    for (const r of dayRows) {
      if (r.failure_code) return false;
      const cls = r.diff_class ?? [];
      if (cls.includes('derivation_gap') || cls.includes('store_write_failed')) return false;
      if (mismatch(r)) {
        if (!cls.includes('derivation_pending')) return false;
        const next = byMemberDate.get(`${r.user_id}|${addDays(date, 1)}`);
        if (!next || next.failure_code || (next.diff_class ?? []).includes('derivation_pending')) return false;
      }
      if (stage === 2 && !cls.includes('consent_withheld') && typeof r.v2_total === 'number' && typeof r.legacy_total === 'number' && r.v2_total !== r.legacy_total) {
        return false;
      }
    }
    return dayRows.length > 0;
  };
  const dates = Array.from(byDate.keys()).sort();
  let run: string[] = [];
  let best: string[] = [];
  let prev: string | null = null;
  for (const d of dates) {
    const green = dayGreen(d, byDate.get(d) ?? []);
    if (green) out.green_days++;
    if (green && prev !== null && addDays(prev, 1) === d && run.length > 0) run.push(d);
    else if (green) run = [d];
    else run = [];
    if (run.length > best.length) best = [...run];
    prev = d;
  }
  out.longest_green_run = best.length;
  const inRun = best.flatMap((d) => byDate.get(d) ?? []).filter((r) => r.formula_ok !== null && r.formula_ok !== undefined);
  out.formula_drift_pct = inRun.length ? Math.round((inRun.filter((r) => r.formula_ok === false).length / inRun.length) * 10000) / 100 : null;
  if (best.length < STAGE_GREEN_DAYS) out.reasons.push('fewer_than_14_consecutive_green_days');
  if (out.formula_drift_pct !== null && out.formula_drift_pct > STAGE_MAX_FORMULA_DRIFT_PCT) out.reasons.push('formula_drift_above_0_5_pct');
  out.met = out.reasons.length === 0;
  return out;
}

/** B2's per-writer dual-write failure counters (codes and counts only — never a member). */
export function dualWriteFailureCounters(counters: Record<string, number>): Record<string, number> {
  const ok = new Set(['stored', 'updated', 'duplicate', 'deleted', 'not_found']);
  return Object.fromEntries(Object.entries(counters).filter(([k]) => !ok.has(k.split(':').slice(1).join(':'))).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface ReportResponse {
  ok: true;
  report: DualComputeReport;
  stage: StageEvaluation;
  dual_write_failure_counters: Record<string, number>;
}

/** Read the table and build the report + the scope's stage (the admin route and the daily OASIS event). */
export async function loadDualComputeReport(
  deps: Pick<DualComputeDeps, 'repo' | 'env' | 'dualWriteCounters'>,
  q: { from: string; to: string; scope: 'device' | 'all' },
): Promise<ReportResponse | { ok: false; code: string }> {
  try {
    const res = await deps.repo.listReportRows(q.from, addDays(q.to, 1), q.scope, REPORT_ROW_LIMIT + 1);
    if (res.error) return { ok: false, code: dualComputeErrorCode(res.error) };
    const all = res.data ?? [];
    const truncated = all.length > REPORT_ROW_LIMIT;
    const rows = truncated ? all.slice(0, REPORT_ROW_LIMIT) : all;
    const inRange = rows.filter((r) => String(r.date).slice(0, 10) <= q.to);
    const { d0, d0s } = dualComputeStartDates(deps.env);
    return {
      ok: true,
      report: buildDualComputeReport(inRange, q, truncated),
      // the next day is read too, so a pending mismatch on `to` can clear
      stage: evaluateStage(rows, q.scope === 'device' ? 1 : 2, q.scope === 'device' ? d0 : d0s),
      dual_write_failure_counters: dualWriteFailureCounters(deps.dualWriteCounters()),
    };
  } catch {
    return { ok: false, code: 'THREW' };
  }
}

/** The daily OASIS `health.index.dual_compute.report` (aggregates only) for one run date. */
async function emitDailyReport(deps: DualComputeDeps, date: string): Promise<boolean> {
  try {
    const { d0, d0s } = dualComputeStartDates(deps.env);
    const payload: Record<string, unknown> = { date };
    for (const scope of (d0s ? ['device', 'all'] : ['device']) as Array<'device' | 'all'>) {
      const res = await loadDualComputeReport(deps, { from: scope === 'device' ? (d0 as string) : (d0s as string), to: date, scope });
      if (!res.ok) {
        payload[scope] = { error: res.code };
        continue;
      }
      const day = await deps.repo.listReportRows(date, addDays(date, 1), scope, REPORT_ROW_LIMIT);
      payload[scope] = {
        day: day.error ? { error: dualComputeErrorCode(day.error) } : buildDualComputeReport((day.data ?? []).filter((r) => String(r.date).slice(0, 10) === date), { from: date, to: date, scope }),
        stage: res.stage,
      };
      payload.dual_write_failure_counters = res.dual_write_failure_counters;
    }
    await deps.emit({
      vtid: INDEX_DUAL_COMPUTE_VTID,
      type: 'health.index.dual_compute.report',
      source: 'health-features',
      status: 'info',
      message: `Vitana Index dual-compute report for ${date}.`,
      payload,
      actor_role: 'system',
      surface: 'system',
    });
    return true;
  } catch {
    safeLog(deps, { event: 'index_dual_compute_report_emit_failed' });
    return false;
  }
}

/** Every spec key's class, for documentation and tests. */
export function keyClassOf(featureKey: string): 'device' | 'self_coded' | 'legacy_only' | null {
  const spec = FEATURE_SPEC.find((s) => s.feature_key === featureKey);
  if (!spec) return null;
  if (spec.codes === null) return 'legacy_only';
  return spec.origin === 'device' ? 'device' : 'self_coded';
}
