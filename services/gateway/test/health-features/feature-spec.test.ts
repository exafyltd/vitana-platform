/**
 * VTID-05162 (Health Hub Phase 1 / B2) — Change 6: the feature spec as data.
 *   - The 18 Index feature keys in the spec equal all four copies of F7: the
 *     live Index function's data counts, the streak helper, routes/integrations.ts
 *     and pillar-agents/base-agent.ts (read from the files, so any drift fails).
 *   - Every code the spec names exists in the S2 catalogue; no glucose/HbA1c.
 *   - The device keys are exactly what the D6a mapper produces.
 *   - The writer table: kinds, flags and source_record_id rules.
 *   - writerValuesForFeature / writerValuesForDailyMetrics.
 */
import * as fs from 'fs';
import * as path from 'path';
import { COLUMN_FEATURES, WORKOUT_FEATURE_KEY } from '../../src/services/wearable-features-bridge';
import { HEALTH_CODES, healthCodeByKey } from '../../src/services/health-store/catalogue';
import {
  DEVICE_FEATURE_KEYS,
  FEATURE_SPEC,
  FEATURE_SPEC_CODES,
  INDEX_FEATURE_KEYS_BY_PILLAR,
  INDEX_PILLARS,
  MAX_COUNT_RECORDS,
  WRITER_SPEC,
  featureSpecOf,
  writerValuesForDailyMetrics,
  writerValuesForFeature,
} from '../../src/services/health-features/feature-spec';
import {
  isDualWriteEnabledFor,
  isFeatureDerivationEnabled,
  isHealthStoreDualWriteDeviceEnabled,
  isHealthStoreDualWriteSelfLoggedEnabled,
} from '../../src/services/health-features/flags';

const REPO = path.join(__dirname, '../../../..');
const GW = path.join(__dirname, '../..');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const arr = (s: string) => s.split(',').map((x) => x.trim().replace(/^'|'$/g, ''));

/** pillar -> keys from a `pillar: ['a','b']` TS object literal. */
function tsLists(file: string): Record<string, string[]> {
  const src = read(file);
  const out: Record<string, string[]> = {};
  for (const m of src.matchAll(/^\s*(nutrition|hydration|exercise|sleep|mental):\s*\[([^\]]+)\]/gm)) out[m[1]] = arr(m[2]);
  return out;
}

describe('the spec equals every F7 copy of the Index feature keys (VTID-05162)', () => {
  const spec = Object.fromEntries(INDEX_PILLARS.map((p) => [p, [...INDEX_FEATURE_KEYS_BY_PILLAR[p]]]));

  it('has 18 keys, 4/2/4/4/4 by pillar', () => {
    expect(FEATURE_SPEC).toHaveLength(18);
    expect(INDEX_PILLARS.map((p) => INDEX_FEATURE_KEYS_BY_PILLAR[p].length)).toEqual([4, 2, 4, 4, 4]);
  });

  it('routes/integrations.ts and pillar-agents/base-agent.ts', () => {
    expect(tsLists(path.join(GW, 'src/routes/integrations.ts'))).toEqual(spec);
    expect(tsLists(path.join(GW, 'src/services/pillar-agents/base-agent.ts'))).toEqual(spec);
  });

  it('the live Index function (data counts) and the streak helper', () => {
    const fn = read(path.join(REPO, 'supabase/migrations/20260424120000_pillar_tags_community_engagement.sql'));
    const counts: Record<string, string[]> = {};
    for (const m of fn.matchAll(/INTO v_cd_(\w+)\s+FROM public\.health_features_daily[\s\S]*?feature_key = ANY\(ARRAY\[([^\]]+)\]\)/g)) counts[m[1]] = arr(m[2]);
    expect(counts).toEqual(spec);
    const streak = read(path.join(REPO, 'supabase/migrations/20260423130000_vitana_index_compute_v3.sql'));
    const block = streak.slice(streak.indexOf('v_features := CASE p_pillar_key'));
    const s: Record<string, string[]> = {};
    for (const m of block.matchAll(/WHEN '(\w+)'\s+THEN ARRAY\[([^\]]+)\]/g)) if (!(m[1] in s)) s[m[1]] = arr(m[2]);
    expect(s).toEqual(spec);
  });
});

describe('codes, origins and bounds (VTID-05162)', () => {
  it('every code exists in the S2 catalogue and none is glucose / HbA1c', () => {
    for (const c of FEATURE_SPEC_CODES) expect(healthCodeByKey(c)).not.toBeNull();
    expect(HEALTH_CODES.some((c) => /gluc|hba1c|cgm/i.test(c.key))).toBe(false);
    expect(featureSpecOf('biomarker_glucose')?.codes).toBeNull();
    expect(featureSpecOf('biomarker_hba1c')?.codes).toBeNull();
  });

  it('the device keys are exactly the D6a mapper output; their bounds are D6a’s', () => {
    expect([...DEVICE_FEATURE_KEYS].sort()).toEqual([...COLUMN_FEATURES.map((c) => c.key), WORKOUT_FEATURE_KEY].sort());
    for (const c of COLUMN_FEATURES) expect(featureSpecOf(c.key)?.bounds).toEqual({ min: c.min, max: c.max });
    for (const s of FEATURE_SPEC.filter((x) => x.origin === 'self_logged')) expect(s.bounds).toBeNull();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FEATURE_SPEC)).toBe(true);
    expect(Object.isFrozen(FEATURE_SPEC[0])).toBe(true);
    expect(Object.isFrozen(WRITER_SPEC)).toBe(true);
  });
});

describe('writers and flags (VTID-05162)', () => {
  it('device flag: webhook writers and wearable_log_workout; self-logged flag: diary, voice, manual, ORB', () => {
    const byFlag = (f: string) => Object.values(WRITER_SPEC).filter((w) => w.flag === f).map((w) => w.writer).sort();
    expect(byFlag('device')).toEqual(['manual_workout', 'webhook_daily', 'webhook_workout']);
    expect(byFlag('self_logged')).toEqual(['diary', 'manual', 'orb_meal', 'orb_mood', 'orb_vitals', 'voice']);
  });

  it('source_record_id rules: replace writers deterministic, event writers per call, webhook workouts external', () => {
    const byKey = (k: string) => Object.values(WRITER_SPEC).filter((w) => w.key === k).map((w) => w.writer).sort();
    expect(byKey('deterministic')).toEqual(['diary', 'manual', 'orb_mood', 'orb_vitals', 'voice', 'webhook_daily']);
    expect(byKey('per_call')).toEqual(['manual_workout', 'orb_meal']);
    expect(byKey('external')).toEqual(['webhook_workout']);
  });

  it('flags are exact "true" and forced off on staging', () => {
    expect(isHealthStoreDualWriteDeviceEnabled({ HEALTH_STORE_DUAL_WRITE_DEVICE: 'true' })).toBe(true);
    expect(isHealthStoreDualWriteDeviceEnabled({ HEALTH_STORE_DUAL_WRITE_DEVICE: '1' })).toBe(false);
    expect(isHealthStoreDualWriteDeviceEnabled({ HEALTH_STORE_DUAL_WRITE_DEVICE: 'true', VITANA_ENV: 'staging' })).toBe(false);
    expect(isHealthStoreDualWriteSelfLoggedEnabled({ HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' })).toBe(true);
    expect(isHealthStoreDualWriteSelfLoggedEnabled({ HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true', VITANA_ENV: 'staging' })).toBe(false);
    expect(isDualWriteEnabledFor('device', { HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' })).toBe(false);
    expect(isFeatureDerivationEnabled({})).toBe(false);
    expect(isFeatureDerivationEnabled({ HEALTH_STORE_DUAL_WRITE_SELF_LOGGED: 'true' })).toBe(true);
  });
});

describe('writer values (VTID-05162)', () => {
  it('maps self-logged feature keys onto catalogue codes, nothing for keys without a code', () => {
    expect(writerValuesForFeature('water_intake', 500, '2026-10-12')).toEqual([{ code: 'water_intake', date: '2026-10-12', value: 500 }]);
    expect(writerValuesForFeature('wearable_heart_rate', 61, '2026-10-12')).toEqual([{ code: 'heart_rate', date: '2026-10-12', stats: { n: 1, sum: 61, min: 61, max: 61 } }]);
    for (const k of ['biomarker_glucose', 'biomarker_hba1c', 'macro_balance', 'hydration_log', 'journal_entry', 'wearable_stress', 'wearable_sleep_stages', 'nope']) {
      expect(writerValuesForFeature(k, 1, '2026-10-12')).toEqual([]);
    }
    expect(writerValuesForFeature('water_intake', Number.NaN, '2026-10-12')).toEqual([]);
  });

  it('meal counts: replace writes 1..N and deletes N+1..10; event writes one', () => {
    const v = writerValuesForFeature('meal_log', 3, '2026-10-12');
    expect(v).toHaveLength(MAX_COUNT_RECORDS);
    expect(v.filter((x) => !x.delete).map((x) => x.index)).toEqual([1, 2, 3]);
    expect(v.filter((x) => x.delete).map((x) => x.index)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(writerValuesForFeature('meal_log', 1, '2026-10-12', 'event')).toEqual([{ code: 'meal', date: '2026-10-12', value: 1 }]);
  });

  it('daily metrics: one value per D6a column present; workout_count becomes one workout record', () => {
    const v = writerValuesForDailyMetrics(
      { sleep_minutes: 420, sleep_efficiency_pct: '91', hrv_avg_ms: 50, hrv_rmssd_ms: null, resting_hr: 54, steps: 8000, vo2max: 44, workout_count: 2, workout_duration_minutes: 75, calories_burned: 2000 },
      '2026-10-12',
    );
    expect(v.map((x) => x.code).sort()).toEqual(['hrv_sdnn', 'resting_heart_rate', 'sleep_efficiency', 'sleep_session', 'steps', 'vo2_max', 'workout']);
    expect(v.find((x) => x.code === 'workout')).toEqual({ code: 'workout', date: '2026-10-12', value: 75, detail: { workout_count: 2 } });
    expect(writerValuesForDailyMetrics({ workout_count: 0 }, '2026-10-12')).toEqual([]);
  });
});
