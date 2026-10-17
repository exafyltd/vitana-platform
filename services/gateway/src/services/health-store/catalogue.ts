/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S2: the health store's code catalogue.
 *
 * This file and the `health_codes` seed in
 * supabase/migrations/20261014100100_vtid_05158_health_store.sql are one
 * catalogue: test/health-store/catalogue.test.ts parses the migration and
 * fails if they differ in any field.
 *
 * - `kind`: `series_sum` / `series_stats` codes are pre-aggregated on the
 *   device into aligned UTC intervals (5 minutes within 30 days, 1 hour
 *   older; Health Sync v1, S1); `record` codes are one discrete record each.
 * - `category`: the data category the consent gate keys on (S7).
 * - Plausibility ranges reject impossible values (sensor errors). They are
 *   never shown to members and never used as clinical limits.
 * - `catalogue_allowed=false` codes are known but not accepted yet
 *   (quarantined CATEGORY_NOT_ALLOWED).
 * - No glucose / CGM / HbA1c code exists (owner decision 7; the SQL has a
 *   CHECK and the test asserts it here too).
 */

export const HEALTH_DATA_CATEGORIES = ['activity', 'sleep', 'heart', 'body', 'labs', 'habits'] as const;
export type HealthDataCategory = (typeof HEALTH_DATA_CATEGORIES)[number];

export const HEALTH_CODE_KINDS = ['series_sum', 'series_stats', 'record'] as const;
export type HealthCodeKind = (typeof HEALTH_CODE_KINDS)[number];

/** How a code's values for one local day become the day's value (S4). */
export type HealthDailyRule = 'sum' | 'mean' | 'min' | 'max' | 'last';

export interface HealthCode {
  code_id: number;
  key: string;
  /** UCUM unit; an item's unit must equal it (UNIT_MISMATCH otherwise). */
  unit: string;
  kind: HealthCodeKind;
  category: HealthDataCategory;
  plausible_min: number | null;
  plausible_max: number | null;
  catalogue_allowed: boolean;
  daily_rule: HealthDailyRule;
}

const c = (
  code_id: number,
  key: string,
  unit: string,
  kind: HealthCodeKind,
  category: HealthDataCategory,
  plausible_min: number | null,
  plausible_max: number | null,
  catalogue_allowed: boolean,
  daily_rule: HealthDailyRule,
): HealthCode => Object.freeze({ code_id, key, unit, kind, category, plausible_min, plausible_max, catalogue_allowed, daily_rule });

export const HEALTH_CODES: readonly HealthCode[] = Object.freeze([
  // activity
  c(1, 'steps', '{steps}', 'series_sum', 'activity', 0, 100000, true, 'sum'),
  c(2, 'active_energy', 'kcal', 'series_sum', 'activity', 0, 20000, true, 'sum'),
  c(3, 'exercise_minutes', 'min', 'series_sum', 'activity', 0, 1440, true, 'sum'),
  c(4, 'distance', 'm', 'series_sum', 'activity', 0, 300000, true, 'sum'),
  c(5, 'workout', 'min', 'record', 'activity', 0, 1440, true, 'sum'),
  c(6, 'vo2_max', 'mL/kg/min', 'record', 'activity', 10, 90, true, 'last'),
  // sleep
  c(20, 'sleep_session', 'min', 'record', 'sleep', 0, 1440, true, 'sum'),
  c(21, 'sleep_efficiency', '%', 'record', 'sleep', 0, 100, true, 'mean'),
  // heart
  c(40, 'heart_rate', '/min', 'series_stats', 'heart', 20, 250, true, 'mean'),
  c(41, 'resting_heart_rate', '/min', 'record', 'heart', 20, 200, true, 'last'),
  c(42, 'hrv_sdnn', 'ms', 'record', 'heart', 1, 300, true, 'mean'),
  c(43, 'hrv_rmssd', 'ms', 'record', 'heart', 1, 300, true, 'mean'),
  c(44, 'blood_pressure_systolic', 'mm[Hg]', 'record', 'heart', 50, 260, false, 'mean'),
  c(45, 'blood_pressure_diastolic', 'mm[Hg]', 'record', 'heart', 30, 160, false, 'mean'),
  // body
  c(60, 'body_weight', 'kg', 'record', 'body', 20, 400, true, 'last'),
  c(61, 'body_fat_percentage', '%', 'record', 'body', 2, 75, true, 'last'),
  // habits (self-logged; refused until the self_logged_health consent key exists, S7)
  c(80, 'water_intake', 'mL', 'record', 'habits', 0, 10000, true, 'sum'),
  c(81, 'meal', '{meal}', 'record', 'habits', 0, 1, true, 'sum'),
  c(82, 'meditation_minutes', 'min', 'record', 'habits', 0, 1440, true, 'sum'),
  c(83, 'mood', '{score}', 'record', 'habits', 1, 10, true, 'mean'),
]);

const BY_KEY: ReadonlyMap<string, HealthCode> = new Map(HEALTH_CODES.map((x) => [x.key, x]));
const BY_ID: ReadonlyMap<number, HealthCode> = new Map(HEALTH_CODES.map((x) => [x.code_id, x]));

export function healthCodeByKey(key: string): HealthCode | null {
  return typeof key === 'string' ? BY_KEY.get(key) ?? null : null;
}

export function healthCodeById(codeId: number): HealthCode | null {
  return BY_ID.get(codeId) ?? null;
}

/** Data category of a catalogue key, or null for an unknown key. */
export function categoryOf(code: string): HealthDataCategory | null {
  return healthCodeByKey(code)?.category ?? null;
}

export function kindOf(code: string): HealthCodeKind | null {
  return healthCodeByKey(code)?.kind ?? null;
}

/** The daily rule of a catalogue key (S4 `value`), or null for an unknown key. */
export function dailyRuleOf(code: string): HealthDailyRule | null {
  return healthCodeByKey(code)?.daily_rule ?? null;
}

export function isSeriesKind(kind: HealthCodeKind): boolean {
  return kind === 'series_sum' || kind === 'series_stats';
}

/**
 * Source precedence by source kind (S2/S6: `source_rank` is not a column of
 * health_sources; the store derives it here). Smaller is better. Program
 * §3.3: a watch/ring beats the phone, a dedicated device cloud beats an
 * aggregator. Self-logged sources rank last; B applies its own member-stated
 * precedence on top through the per-source values S4 returns.
 */
const SOURCE_RANKS: Readonly<Record<string, number>> = Object.freeze({
  device_cloud: 1,
  phone_store: 2,
  aggregator: 3,
  partner: 4,
  manual: 5,
  diary: 6,
  voice: 7,
});
export const UNKNOWN_SOURCE_RANK = 9;

export function sourceRankOf(kind: string): number {
  return SOURCE_RANKS[kind] ?? UNKNOWN_SOURCE_RANK;
}
