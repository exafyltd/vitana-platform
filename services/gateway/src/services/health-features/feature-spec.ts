/**
 * VTID-05162 (Health Hub Phase 1 / B2, program VTID-05020) — B Change 6: the
 * mapping between the Vitana Index's feature keys and the health store's
 * codes, as data.
 *
 * Plan: docs/validation/VTID-05162/plan-sparring.md (Change 6, Shared
 * interfaces S2/S3). Three things live here, all frozen:
 *
 *   1. FEATURE_SPEC — one entry per feature key the Index counts (exactly the
 *      18 keys of F7, identical in `health_compute_vitana_index_for_user`, the
 *      streak helper, routes/integrations.ts and pillar-agents/base-agent.ts;
 *      test/health-features asserts the four lists equal this one). Each entry
 *      names its pillar, its `origin` (`device` for the seven keys the D6a
 *      mapper produces, otherwise `self_logged`), the S2 code(s) it is derived
 *      from or `null` (never derived), the aggregation (count / sum / latest),
 *      the unit of the derived row and the plausibility bounds (D6a
 *      COLUMN_FEATURES reused for the device keys).
 *   2. WRITER_SPEC — every legacy writer that dual-writes (Change 7): the
 *      source kind it writes as, the flag that activates it, and its
 *      `source_record_id` rule. S3 replaces by key, there is no replace flag:
 *        - `deterministic`  `<writer>:<date>:<code>[:<n>]` — replace-semantics
 *                           writers (diary, voice, manual, log_mood, log_vitals,
 *                           webhook daily metrics);
 *        - `per_call`       `<writer>:<call id>` — event writers (log_meal,
 *                           the manual workout action);
 *        - `external`       `<connector>:<external_workout_id>` —
 *                           webhook workouts.
 *   3. writerValuesForFeature — a legacy (feature_key, value, date) write as
 *      store values, for the self-logged writers that speak in feature keys.
 *
 * `null` codes (never derived, they stay legacy-only and are classified
 * `writer_not_rerouted` by B3): biomarker_glucose / biomarker_hba1c (owner
 * decision 7, Reconciliation 11), macro_balance, wearable_sleep_stages and
 * wearable_stress (no S2 code), and — decided inside the plan, because S2 has
 * no code for them either — journal_entry and hydration_log. hydration_log is
 * not derived from `water_intake`: that would add a second row for every water
 * day that the legacy writers never produce.
 */

import { COLUMN_FEATURES, WORKOUT_FEATURE_KEY } from '../wearable-features-bridge';
import { healthCodeByKey } from '../health-store/catalogue';
import type { HealthSourceKind } from '../health-sources/health-sources';

export const HEALTH_FEATURES_VTID = 'VTID-05162';
/** Stamped on every derived row (`derivation_version`, metadata). Bump when deriveFeatures changes. */
export const DERIVATION_VERSION = 'b2.1';
export const DERIVED_SOURCE = 'derived_v2';

export const INDEX_PILLARS = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'] as const;
export type IndexPillar = (typeof INDEX_PILLARS)[number];

export type FeatureAggregation = 'count' | 'sum' | 'latest';
export type FeatureOrigin = 'device' | 'self_logged';

export interface FeatureSpecEntry {
  feature_key: string;
  pillar: IndexPillar;
  origin: FeatureOrigin;
  /** S2 codes, in precedence order, or null: never derived. */
  codes: readonly string[] | null;
  aggregation: FeatureAggregation;
  unit: string;
  /** Inclusive plausibility bounds on the derived value (D6a for device keys); null = catalogue bounds only. */
  bounds: Readonly<{ min: number; max: number }> | null;
}

function d6aBounds(key: string): Readonly<{ min: number; max: number }> {
  const c = COLUMN_FEATURES.find((x) => x.key === key);
  if (!c) throw new Error(`feature-spec: D6a has no COLUMN_FEATURES entry for ${key}`);
  return Object.freeze({ min: c.min, max: c.max });
}

const e = (
  feature_key: string,
  pillar: IndexPillar,
  origin: FeatureOrigin,
  codes: readonly string[] | null,
  aggregation: FeatureAggregation,
  unit: string,
  bounds: Readonly<{ min: number; max: number }> | null,
): FeatureSpecEntry =>
  Object.freeze({ feature_key, pillar, origin, codes: codes ? Object.freeze([...codes]) : null, aggregation, unit, bounds });

/** The 18 Index feature keys (F7), pillar order then key order of the SQL. */
export const FEATURE_SPEC: readonly FeatureSpecEntry[] = Object.freeze([
  // nutrition
  e('biomarker_glucose', 'nutrition', 'self_logged', null, 'latest', 'mg/dL', null),
  e('biomarker_hba1c', 'nutrition', 'self_logged', null, 'latest', '%', null),
  e('meal_log', 'nutrition', 'self_logged', ['meal'], 'count', 'meal', null),
  e('macro_balance', 'nutrition', 'self_logged', null, 'latest', 'score', null),
  // hydration
  e('water_intake', 'hydration', 'self_logged', ['water_intake'], 'sum', 'ml', null),
  e('hydration_log', 'hydration', 'self_logged', null, 'count', 'count', null),
  // exercise
  e('wearable_heart_rate', 'exercise', 'device', ['resting_heart_rate', 'heart_rate'], 'latest', 'bpm', d6aBounds('wearable_heart_rate')),
  e('wearable_steps', 'exercise', 'device', ['steps'], 'sum', 'steps', d6aBounds('wearable_steps')),
  e(WORKOUT_FEATURE_KEY, 'exercise', 'device', ['workout'], 'count', 'count', null),
  e('vo2_max', 'exercise', 'device', ['vo2_max'], 'latest', 'ml/kg/min', d6aBounds('vo2_max')),
  // sleep
  e('wearable_sleep_duration', 'sleep', 'device', ['sleep_session'], 'sum', 'min', d6aBounds('wearable_sleep_duration')),
  e('wearable_sleep_efficiency', 'sleep', 'device', ['sleep_efficiency'], 'latest', '%', d6aBounds('wearable_sleep_efficiency')),
  e('wearable_hrv', 'sleep', 'device', ['hrv_rmssd', 'hrv_sdnn'], 'latest', 'ms', d6aBounds('wearable_hrv')),
  e('wearable_sleep_stages', 'sleep', 'self_logged', null, 'latest', 'min', null),
  // mental
  e('wearable_stress', 'mental', 'self_logged', null, 'latest', 'score', null),
  e('mood_entry', 'mental', 'self_logged', ['mood'], 'latest', 'score', null),
  e('meditation_minutes', 'mental', 'self_logged', ['meditation_minutes'], 'sum', 'min', null),
  e('journal_entry', 'mental', 'self_logged', null, 'count', 'count', null),
]);

const SPEC_BY_KEY: ReadonlyMap<string, FeatureSpecEntry> = new Map(FEATURE_SPEC.map((x) => [x.feature_key, x]));

export function featureSpecOf(featureKey: string): FeatureSpecEntry | null {
  return SPEC_BY_KEY.get(featureKey) ?? null;
}

/** pillar -> its feature keys, in spec order (the shape of the four F7 copies). */
export const INDEX_FEATURE_KEYS_BY_PILLAR: Readonly<Record<IndexPillar, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    INDEX_PILLARS.map((p) => [p, Object.freeze(FEATURE_SPEC.filter((x) => x.pillar === p).map((x) => x.feature_key))]),
  ) as Record<IndexPillar, readonly string[]>,
);

/** The seven device keys of F7 (what the D6a mapper produces). */
export const DEVICE_FEATURE_KEYS: readonly string[] = Object.freeze(FEATURE_SPEC.filter((x) => x.origin === 'device').map((x) => x.feature_key));

/** Keys deriveFeatures can produce (codes !== null). */
export const DERIVED_FEATURE_KEYS: readonly string[] = Object.freeze(FEATURE_SPEC.filter((x) => x.codes !== null).map((x) => x.feature_key));

/** Every S2 code the derivation reads (S4 `codes`). */
export const FEATURE_SPEC_CODES: readonly string[] = Object.freeze(
  Array.from(new Set(FEATURE_SPEC.flatMap((x) => (x.codes ? [...x.codes] : [])))),
);

// ---------------------------------------------------------------------------
// Writers (Change 7)
// ---------------------------------------------------------------------------

export const HEALTH_WRITER_IDS = [
  'diary',
  'voice',
  'manual',
  'orb_meal',
  'orb_mood',
  'orb_vitals',
  'webhook_daily',
  'webhook_workout',
  'manual_workout',
] as const;
export type HealthWriterId = (typeof HEALTH_WRITER_IDS)[number];

/** Which dual-write flag activates a writer (Change 7). */
export type HealthWriterClass = 'device' | 'self_logged';
export type SourceRecordIdRule = 'deterministic' | 'per_call' | 'external';

export interface WriterSpecEntry {
  writer: HealthWriterId;
  /** The legacy call site (documentation and the boundary test). */
  site: string;
  kind: Extract<HealthSourceKind, 'device_cloud' | 'manual' | 'voice' | 'diary'>;
  flag: HealthWriterClass;
  key: SourceRecordIdRule;
}

const w = (writer: HealthWriterId, site: string, kind: WriterSpecEntry['kind'], flag: HealthWriterClass, key: SourceRecordIdRule): WriterSpecEntry =>
  Object.freeze({ writer, site, kind, flag, key });

export const WRITER_SPEC: Readonly<Record<HealthWriterId, WriterSpecEntry>> = Object.freeze({
  diary: w('diary', 'services/diary-health-extractor.ts persistDiaryHealthFeatures (routes/memory.ts, services/memory/diary.ts, orb-tools-shared.ts)', 'diary', 'self_logged', 'deterministic'),
  voice: w('voice', 'services/voice-tools/health-log.ts logHealthSignal', 'voice', 'self_logged', 'deterministic'),
  manual: w('manual', 'routes/integrations.ts POST /manual/log', 'manual', 'self_logged', 'deterministic'),
  orb_meal: w('orb_meal', 'services/orb-tools/health-depth-tools.ts tool_log_meal', 'voice', 'self_logged', 'per_call'),
  orb_mood: w('orb_mood', 'services/orb-tools/health-depth-tools.ts tool_log_mood', 'voice', 'self_logged', 'deterministic'),
  orb_vitals: w('orb_vitals', 'services/orb-tools/health-depth-tools.ts tool_log_vitals', 'voice', 'self_logged', 'deterministic'),
  webhook_daily: w('webhook_daily', 'routes/connector-webhooks.ts wearable_daily_metrics persist', 'device_cloud', 'device', 'deterministic'),
  webhook_workout: w('webhook_workout', 'routes/connector-webhooks.ts wearable_workouts persist', 'device_cloud', 'device', 'external'),
  manual_workout: w('manual_workout', 'services/action-executors.ts wearable_log_workout', 'manual', 'device', 'per_call'),
});

// ---------------------------------------------------------------------------
// Store values
// ---------------------------------------------------------------------------

/**
 * One value a writer hands to recordToHealthStore. `code` is an S2 key; the
 * unit is always the catalogue's. `start` defaults to 00:00:00Z of `date`
 * (decision inside the plan: every B2 write is anchored at UTC midnight of
 * the legacy row's `date` and written with tz UTC, so the store's local date
 * and the legacy `date` are the same day; the derivation reads with tz UTC).
 */
export interface WriterValue {
  code: string;
  date: string;
  value?: number | null;
  stats?: { n: number; sum: number; min: number; max: number } | null;
  start?: string;
  end?: string | null;
  /** n-th record of a count on a deterministic key (`…:<code>:<n>`). */
  index?: number;
  /** Webhook workouts: the vendor's workout id. */
  external_id?: string;
  /** A deterministic record the writer no longer holds (count went down). */
  delete?: boolean;
  detail?: Record<string, unknown> | null;
}

/** Deterministic count records per day (meal_log): more than this is not a plausible day. */
export const MAX_COUNT_RECORDS = 10;

/** Self-logged feature key -> the S2 code a member-stated value is written as. */
const SELF_LOGGED_WRITE_CODE: Readonly<Record<string, string>> = Object.freeze({
  meal_log: 'meal',
  water_intake: 'water_intake',
  wearable_heart_rate: 'heart_rate',
  wearable_steps: 'steps',
  wearable_workout: 'workout',
  vo2_max: 'vo2_max',
  wearable_sleep_duration: 'sleep_session',
  wearable_sleep_efficiency: 'sleep_efficiency',
  wearable_hrv: 'hrv_rmssd',
  mood_entry: 'mood',
  meditation_minutes: 'meditation_minutes',
});

export function selfLoggedWriteCode(featureKey: string): string | null {
  return SELF_LOGGED_WRITE_CODE[featureKey] ?? null;
}

/**
 * A legacy (feature_key, value, date) write as store values. `mode` says how
 * the writer's legacy row behaves: `replace` (the day's value is replaced —
 * deterministic keys) or `event` (one more event — one record, per-call key).
 * Returns [] for a key with no S2 code (it stays legacy-only).
 *
 * - count keys (meal_log): `replace` writes records 1..N and deletes N+1..10
 *   (so a lower count replaces a higher one); `event` writes one record.
 * - heart rate is a series_stats code: one stats item (n = 1).
 */
export function writerValuesForFeature(featureKey: string, value: number, date: string, mode: 'replace' | 'event' = 'replace'): WriterValue[] {
  const code = selfLoggedWriteCode(featureKey);
  if (!code || !Number.isFinite(value)) return [];
  const cat = healthCodeByKey(code);
  if (!cat) return [];
  if (code === 'meal') {
    if (mode === 'event') return [{ code, date, value: 1 }];
    const n = Math.max(0, Math.min(MAX_COUNT_RECORDS, Math.round(value)));
    const out: WriterValue[] = [];
    for (let i = 1; i <= MAX_COUNT_RECORDS; i++) out.push(i <= n ? { code, date, value: 1, index: i } : { code, date, index: i, delete: true });
    return out;
  }
  if (cat.kind === 'series_stats') return [{ code, date, stats: { n: 1, sum: value, min: value, max: value } }];
  return [{ code, date, value }];
}

/**
 * A webhook `wearable_daily_metrics` row (the legacy patch) as store values,
 * one per column the D6a mapper reads. A column the event did not carry is
 * not written (the legacy upsert keeps its old value too). The daily
 * `workout_count` becomes one workout record (`…:workout`) with the day's
 * duration as value, so a day with workouts but no per-workout event still
 * has a workout row (the D6a rule: max(workout_count, workout rows)).
 */
export function writerValuesForDailyMetrics(row: Record<string, unknown>, date: string): WriterValue[] {
  const num = (k: string): number | null => {
    const v = row[k];
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out: WriterValue[] = [];
  const put = (code: string, v: number | null) => {
    if (v !== null) out.push({ code, date, value: v });
  };
  put('sleep_session', num('sleep_minutes'));
  put('sleep_efficiency', num('sleep_efficiency_pct'));
  put('hrv_sdnn', num('hrv_avg_ms'));
  put('hrv_rmssd', num('hrv_rmssd_ms'));
  put('resting_heart_rate', num('resting_hr'));
  put('vo2_max', num('vo2max'));
  const steps = num('steps');
  if (steps !== null) out.push({ code: 'steps', date, value: steps });
  const workouts = num('workout_count');
  if (workouts !== null && workouts > 0) {
    const minutes = num('workout_duration_minutes');
    out.push({ code: 'workout', date, value: minutes, detail: { workout_count: Math.floor(workouts) } });
  }
  return out;
}
