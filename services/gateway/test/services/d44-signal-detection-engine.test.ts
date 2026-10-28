// VTID-01138 — unit tests for the D44 Proactive Signal Detection & Early
// Intervention Engine (d44-signal-detection-engine.ts).
//
// Scope (this file):
//   1. Pure deterministic math/helpers — analyzeTrend, isPersistent,
//      isDirectional, countEvidenceSources, determineImpact,
//      determineSuggestedAction, generateExplainabilityText. These carry
//      the actual "detection rule" logic (persistent >=3/>=7d, directional,
//      confidence >=70, evidence >=2 sources) and are tested with
//      hand-verified expected values (see the confidence/magnitude formula
//      reproduced independently to derive fixtures), not just smoke-tested.
//   2. The four implemented detectors — detectHealthDrift,
//      detectSocialWithdrawal, detectPositiveMomentum,
//      detectRoutineInstability — happy paths with exact expected signal
//      fields, plus boundary rejections (insufficient data, <2 evidence
//      sources, confidence below 70, per-detector magnitude thresholds).
//   3. Public RPC-backed API — createSignal, getActiveSignals,
//      getSignalDetails, acknowledgeSignal, dismissSignal,
//      recordIntervention, getSignalStats, runDetection,
//      getSignalContextForOrb — client resolution (UNAUTHENTICATED /
//      SERVICE_UNAVAILABLE / dev-sandbox bootstrap, mirroring D40's
//      isolation guarantee since this module also has no explicit
//      tenant_id param), RPC parameter mapping, and OASIS event emission.
//   4. runDetection's rate-limiting (skip when a recent signal already
//      exists, unless force=true) and unimplemented-signal-type handling.
//
// The d44_predictive_signals / d44_intervention_history table names used
// here are taken directly from the source (getSignalDetails, runDetection's
// rate-limit check) — CLAUDE.md's `d44_predictive_signals` doc entry is
// confirmed accurate, not assumed.

// Note: fixture arrays used against `analyzeTrend` below (e.g. the 10-point
// linear ramps) had their exact expected {direction, magnitude, confidence}
// derived by running the module's own formula offline against candidate
// inputs — the assertions call the real exported `analyzeTrend`.

// ---------------------------------------------------------------------------
// Supabase mock (module boundary: '@supabase/supabase-js')
// ---------------------------------------------------------------------------

interface TableResponse {
  data: unknown;
  error: { message: string } | null;
}

function createSupabaseMock() {
  const tableResponses = new Map<string, TableResponse>();
  const rpcHandlers = new Map<string, TableResponse | ((params: any) => TableResponse)>();
  const calls: Array<
    | { type: 'table'; table: string; filters: Record<string, unknown> }
    | { type: 'rpc'; name: string; params: any }
  > = [];
  let currentTable: string | null = null;
  let pendingFilters: Record<string, unknown> = {};

  const client: any = {};
  client.from = jest.fn((t: string) => {
    currentTable = t;
    pendingFilters = {};
    return client;
  });
  client.select = jest.fn(() => client);
  client.eq = jest.fn((col: string, val: unknown) => {
    pendingFilters[col] = val;
    return client;
  });
  client.gte = jest.fn((col: string, val: unknown) => {
    pendingFilters[col] = val;
    return client;
  });
  client.order = jest.fn(() => client);
  client.limit = jest.fn(() => client);
  client.then = jest.fn((resolve: any, reject: any) => {
    const table = currentTable ?? '';
    calls.push({ type: 'table', table, filters: { ...pendingFilters } });
    currentTable = null;
    const r = tableResponses.has(table) ? tableResponses.get(table)! : { data: [], error: null };
    return Promise.resolve(r).then(resolve, reject);
  });
  client.rpc = jest.fn((name: string, params?: any) => {
    calls.push({ type: 'rpc', name, params });
    const handler = rpcHandlers.get(name);
    const r: TableResponse =
      typeof handler === 'function' ? handler(params) : handler ?? { data: null, error: null };
    return Promise.resolve(r);
  });

  return {
    client,
    setTable(t: string, r: TableResponse) {
      tableResponses.set(t, r);
    },
    setRpc(name: string, r: TableResponse | ((params: any) => TableResponse)) {
      rpcHandlers.set(name, r);
    },
    calls,
    reset() {
      tableResponses.clear();
      rpcHandlers.clear();
      calls.length = 0;
      currentTable = null;
      pendingFilters = {};
    },
  };
}

const supabaseMock = createSupabaseMock();
const mockCreateClient = jest.fn(() => supabaseMock.client);
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

const mockEmitOasisEvent = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import {
  analyzeTrend,
  isPersistent,
  isDirectional,
  countEvidenceSources,
  determineImpact,
  determineSuggestedAction,
  generateExplainabilityText,
  detectHealthDrift,
  detectSocialWithdrawal,
  detectPositiveMomentum,
  detectRoutineInstability,
  DETECTION_THRESHOLDS,
  createSignal,
  getActiveSignals,
  getSignalDetails,
  acknowledgeSignal,
  dismissSignal,
  recordIntervention,
  getSignalStats,
  runDetection,
  getSignalContextForOrb,
} from '../../src/services/d44-signal-detection-engine';
import type {
  DetectionInput,
  VitanaScoreInput,
  HealthFeatureInput,
  DiaryInput,
  LongitudinalDataPointInput,
  CreateSignalRequest,
  PredictiveSignal,
} from '../../src/types/signal-detection';

const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  supabaseMock.reset();
  mockCreateClient.mockClear();
  mockEmitOasisEvent.mockReset();
  mockEmitOasisEvent.mockResolvedValue({ ok: true, event_id: 'evt-1' });

  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  delete process.env.ENVIRONMENT;
  delete process.env.VITANA_ENV;
});

// ===========================================================================
// 1. Pure deterministic logic
// ===========================================================================

describe('analyzeTrend', () => {
  it('returns stable/0/0 for fewer than 3 data points', () => {
    expect(analyzeTrend([])).toEqual({ direction: 'stable', magnitude: 0, confidence: 0 });
    expect(analyzeTrend([5, 10])).toEqual({ direction: 'stable', magnitude: 0, confidence: 0 });
  });

  it('detects a clean increasing trend with the exact expected magnitude/confidence', () => {
    // Hand-verified: slope>0, magnitude=min(100,|((85-40)/40)*100|)... clipped at 100,
    // confidence=round((1-cv)*50+(10/10)*50).
    expect(analyzeTrend([40, 45, 50, 55, 60, 65, 70, 75, 80, 85])).toEqual({
      direction: 'increasing',
      magnitude: 100,
      confidence: 89,
    });
  });

  it('detects a clean decreasing trend', () => {
    expect(analyzeTrend([85, 80, 75, 70, 65, 60, 55, 50, 45, 40])).toEqual({
      direction: 'decreasing',
      magnitude: 53,
      confidence: 89,
    });
  });

  it('classifies near-constant values as stable with 0 magnitude', () => {
    expect(analyzeTrend([50, 50, 50, 50])).toEqual({ direction: 'stable', magnitude: 0, confidence: 70 });
  });

  it('classifies high-variance/near-zero-slope values as oscillating', () => {
    expect(analyzeTrend([10, 50, 10, 50, 10])).toEqual({ direction: 'oscillating', magnitude: 0, confidence: 37 });
  });

  it('caps magnitude at 100 even for very large relative swings', () => {
    const result = analyzeTrend([10, 20, 30]);
    expect(result.magnitude).toBeLessThanOrEqual(100);
    expect(result.magnitude).toBe(100);
  });

  it('treats a zero-then-nonzero series as 100% magnitude increase (guards the /0 special case)', () => {
    expect(analyzeTrend([0, 0, 5])).toEqual({ direction: 'increasing', magnitude: 100, confidence: 0 });
  });

  it('treats an all-zero series as stable with 0 magnitude (guards the /0 special case entirely)', () => {
    expect(analyzeTrend([0, 0, 0])).toEqual({ direction: 'stable', magnitude: 0, confidence: 65 });
  });
});

describe('isPersistent', () => {
  const at = (iso: string, value: number) => ({ recorded_at: iso, value });

  it('is persistent once the occurrence count alone reaches the minimum (3), regardless of dates', () => {
    const points = [at('2026-07-01', 1), at('2026-07-01', 2), at('2026-07-01', 3)];
    expect(isPersistent(points)).toBe(true);
  });

  it('with exactly 2 points, is persistent only once the day span reaches the minimum (7)', () => {
    expect(isPersistent([at('2026-07-01', 1), at('2026-07-08', 2)])).toBe(true); // 7-day span
    expect(isPersistent([at('2026-07-01', 1), at('2026-07-06', 2)])).toBe(false); // 5-day span
  });

  it('is never persistent with fewer than 2 points', () => {
    expect(isPersistent([at('2026-07-01', 1)])).toBe(false);
    expect(isPersistent([])).toBe(false);
  });

  it('respects custom minOccurrences/minDays overrides', () => {
    expect(isPersistent([at('2026-07-01', 1), at('2026-07-01', 2)], 2, 999)).toBe(true);
  });
});

describe('isDirectional', () => {
  it('is never directional for oscillating or stable trends, regardless of magnitude', () => {
    expect(isDirectional('oscillating', 90)).toBe(false);
    expect(isDirectional('stable', 90)).toBe(false);
  });

  it('requires magnitude >= 10 for increasing/decreasing trends', () => {
    expect(isDirectional('increasing', 9)).toBe(false);
    expect(isDirectional('increasing', 10)).toBe(true);
    expect(isDirectional('decreasing', 15)).toBe(true);
  });
});

describe('countEvidenceSources', () => {
  it('collapses duplicate type:source pairs into one', () => {
    const evidence = [
      { type: 'health', source: 'a' },
      { type: 'health', source: 'a' },
      { type: 'diary', source: 'a' },
    ];
    expect(countEvidenceSources(evidence)).toBe(2);
  });

  it('returns 0 for empty evidence', () => {
    expect(countEvidenceSources([])).toBe(0);
  });
});

describe('determineImpact', () => {
  it('health_drift / cognitive_load_increase: high when magnitude>=40 OR confidence>=85', () => {
    expect(determineImpact('health_drift', 40, 50)).toBe('high');
    expect(determineImpact('health_drift', 39, 85)).toBe('high');
    expect(determineImpact('cognitive_load_increase', 45, 10)).toBe('high');
  });

  it('health_drift: falls to medium (magnitude>=30 or confidence>=80), else low', () => {
    expect(determineImpact('health_drift', 39, 84)).toBe('medium');
    expect(determineImpact('health_drift', 10, 50)).toBe('low');
  });

  it('social_withdrawal: high specifically at magnitude>=50, medium at >=30, else low', () => {
    expect(determineImpact('social_withdrawal', 50, 10)).toBe('high');
    expect(determineImpact('social_withdrawal', 49, 10)).toBe('medium');
    expect(determineImpact('social_withdrawal', 10, 10)).toBe('low');
  });

  it('other signal types: medium via magnitude>=30 or confidence>=80, else low (no high tier)', () => {
    expect(determineImpact('routine_instability', 30, 10)).toBe('medium');
    expect(determineImpact('routine_instability', 10, 80)).toBe('medium');
    expect(determineImpact('routine_instability', 10, 10)).toBe('low');
  });
});

describe('determineSuggestedAction', () => {
  it('high impact always maps to check_in, regardless of signal type', () => {
    expect(determineSuggestedAction('health_drift', 'high')).toBe('check_in');
    expect(determineSuggestedAction('positive_momentum', 'high')).toBe('check_in');
  });

  it('positive_momentum maps to awareness at any non-high impact (checked before the medium branch)', () => {
    expect(determineSuggestedAction('positive_momentum', 'low')).toBe('awareness');
    expect(determineSuggestedAction('positive_momentum', 'medium')).toBe('awareness');
  });

  it('medium impact (non positive_momentum) maps to reflection', () => {
    expect(determineSuggestedAction('health_drift', 'medium')).toBe('reflection');
  });

  it('low impact (non positive_momentum) maps to awareness', () => {
    expect(determineSuggestedAction('health_drift', 'low')).toBe('awareness');
  });
});

describe('generateExplainabilityText', () => {
  it('health_drift: significantly (>=50) + time window text collapsed correctly', () => {
    const text = generateExplainabilityText('health_drift', 'increasing', 60, 'last_7_days', 3);
    expect(text).toBe(
      'Over the last 7 days, your health metrics have been significantly increasing. This pattern was detected across 3 different data points.'
    );
  });

  it('behavioral_drift: noticeably (30-49), direction unused in this template', () => {
    const text = generateExplainabilityText('behavioral_drift', 'decreasing', 35, 'last_14_days', 4);
    expect(text).toBe('Your behavior patterns have been noticeably shifting over the last 14 days. We noticed this change based on 4 observations.');
  });

  it('routine_instability: magnitude/direction are not referenced in this template at all', () => {
    const text = generateExplainabilityText('routine_instability', 'oscillating', 20, 'last_30_days', 2);
    expect(text).toBe('Your regular routines appear less stable than usual over the last 30 days. This is based on 2 data points showing more variation.');
  });

  it('cognitive_load_increase template', () => {
    const text = generateExplainabilityText('cognitive_load_increase', 'increasing', 55, 'last_7_days', 2);
    expect(text).toBe('Signs suggest significantly higher mental load over the last 7 days. This pattern emerged from 2 different indicators.');
  });

  it('social_withdrawal template', () => {
    const text = generateExplainabilityText('social_withdrawal', 'decreasing', 53, 'last_14_days', 2);
    expect(text).toBe('Your social interactions have significantly decreased over the last 14 days. We detected this trend from 2 observations.');
  });

  it('social_overload template: slightly (<30)', () => {
    const text = generateExplainabilityText('social_overload', 'increasing', 25, 'last_7_days', 3);
    expect(text).toBe("You've had slightly more social interactions than usual over the last 7 days. This is based on 3 data points.");
  });

  it('preference_shift template', () => {
    const text = generateExplainabilityText('preference_shift', 'increasing', 40, 'last_30_days', 5);
    expect(text).toBe('Your preferences appear to be evolving over the last 30 days. We noticed noticeably changes across 5 preference indicators.');
  });

  it('positive_momentum template', () => {
    const text = generateExplainabilityText('positive_momentum', 'increasing', 42, 'last_14_days', 2);
    expect(text).toBe('Great news! Positive trends detected over the last 14 days. We saw noticeably improvements across 2 areas.');
  });

  it('falls back to the generic template for an unrecognized signal type', () => {
    const text = generateExplainabilityText('not_a_real_type' as any, 'stable', 10, 'last_7_days', 1);
    expect(text).toBe('A pattern was detected over the last 7 days based on 1 data points.');
  });
});

// ===========================================================================
// 2. Detectors
// ===========================================================================

function vitanaScore(id: string, date: string, overall_score: number): VitanaScoreInput {
  return { id, date, overall_score, domain_scores: {} };
}
function healthFeature(id: string, date: string, feature_key: string, value: number): HealthFeatureInput {
  return { id, date, feature_key, value };
}
function diaryEntry(overrides: Partial<DiaryInput> & { id: string; recorded_at: string }): DiaryInput {
  return { ...overrides };
}
function longPoint(overrides: Partial<LongitudinalDataPointInput> & { id: string; domain: string; key: string; recorded_at: string }): LongitudinalDataPointInput {
  return { value: null, ...overrides };
}

describe('detectHealthDrift', () => {
  it('is not detected when both health_features and vitana_scores are below the 5-point minimum', () => {
    const input: DetectionInput = {
      health_features: [healthFeature('h1', 'd1', 'hr', 60), healthFeature('h2', 'd2', 'hr', 62)],
      vitana_scores: [vitanaScore('v1', 'd1', 50), vitanaScore('v2', 'd2', 52), vitanaScore('v3', 'd3', 54)],
    };
    const result = detectHealthDrift(input, 'last_14_days');
    expect(result.detected).toBe(false);
    expect(result.signal).toBeUndefined();
  });

  it('is not detected when data is sufficient but flat (no directional evidence at all)', () => {
    const input: DetectionInput = {
      vitana_scores: [50, 50, 50, 50, 50].map((s, i) => vitanaScore(`v${i}`, `d${i}`, s)),
      health_features: [10, 10, 10, 10, 10].map((v, i) => healthFeature(`h${i}`, `d${i}`, 'hr', v)),
    };
    const result = detectHealthDrift(input, 'last_14_days');
    expect(result.detected).toBe(false);
  });

  it('is not detected with 2 evidence sources when overall confidence stays below 70', () => {
    // Two different feature keys, each individually directional + confidence
    // >=60 (so each is added as evidence), but neither reaches 70 and there
    // is no vitana_scores trend to lift the ceiling.
    const input: DetectionInput = {
      health_features: [
        ...[50, 55, 60].map((v, i) => healthFeature(`f1-${i}`, `d${i}`, 'feature_one', v)),
        ...[50, 55, 60].map((v, i) => healthFeature(`f2-${i}`, `d${i}`, 'feature_two', v)),
      ],
    };
    const result = detectHealthDrift(input, 'last_14_days');
    expect(result.detected).toBe(false);
  });

  it('detects a health drift signal from a strong vitana-score trend plus a corroborating feature trend', () => {
    const input: DetectionInput = {
      vitana_scores: [40, 45, 50, 55, 60, 65, 70, 75, 80, 85].map((s, i) => vitanaScore(`v${i}`, `d${i}`, s)),
      health_features: [50, 55, 60, 65, 70].map((v, i) => healthFeature(`h${i}`, `d${i}`, 'resting_hr', v)),
    };

    const result = detectHealthDrift(input, 'last_14_days');

    expect(result.detected).toBe(true);
    expect(result.signal).toEqual({
      signal_type: 'health_drift',
      confidence: 89,
      time_window: 'last_14_days',
      detected_change: 'Health metrics increasing by 100%',
      user_impact: 'high',
      suggested_action: 'check_in',
      explainability_text:
        'Over the last 14 days, your health metrics have been significantly increasing. This pattern was detected across 2 different data points.',
      evidence_count: 2,
      domains_analyzed: ['health'],
      data_points_analyzed: 15, // 5 features + 10 scores
    });
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence!.map((e) => e.source).sort()).toEqual(['resting_hr', 'vitana_scores']);
  });
});

describe('detectSocialWithdrawal', () => {
  it('is not detected with no input data', () => {
    expect(detectSocialWithdrawal({}, 'last_14_days').detected).toBe(false);
  });

  it('is not detected when the longitudinal decline is below the 20% magnitude gate', () => {
    const input: DetectionInput = {
      longitudinal_data_points: [100, 98, 96].map((v, i) =>
        longPoint({ id: `s${i}`, domain: 'social', key: 'strength', numeric_value: v, recorded_at: `d${i}` })
      ),
    };
    expect(detectSocialWithdrawal(input, 'last_14_days').detected).toBe(false);
  });

  it('is not detected with only 1 evidence source, even at high confidence (evidence-count gate)', () => {
    const input: DetectionInput = {
      longitudinal_data_points: [85, 80, 75, 70, 65, 60, 55, 50, 45, 40].map((v, i) =>
        longPoint({ id: `s${i}`, domain: 'social', key: 'strength', numeric_value: v, recorded_at: `d${i}` })
      ),
    };
    const result = detectSocialWithdrawal(input, 'last_14_days');
    expect(result.detected).toBe(false);
  });

  it('is not detected when 2 evidence sources exist but the longitudinal trend confidence stays below 70', () => {
    const input: DetectionInput = {
      longitudinal_data_points: [90, 80, 70, 60, 50].map((v, i) =>
        longPoint({ id: `s${i}`, domain: 'social', key: 'strength', numeric_value: v, recorded_at: `d${i}` })
      ),
      diary_entries: [
        diaryEntry({ id: 'e1', recorded_at: 'd1', topics: ['friend'], sentiment: 'negative' }),
        diaryEntry({ id: 'e2', recorded_at: 'd2', topics: ['friend'], sentiment: 'negative' }),
      ],
    };
    const result = detectSocialWithdrawal(input, 'last_14_days');
    expect(result.detected).toBe(false);
  });

  it('detects social withdrawal from a strong longitudinal decline plus corroborating negative diary mentions', () => {
    const input: DetectionInput = {
      longitudinal_data_points: [85, 80, 75, 70, 65, 60, 55, 50, 45, 40].map((v, i) =>
        longPoint({ id: `s${i}`, domain: 'social', key: 'strength', numeric_value: v, recorded_at: `d${i}` })
      ),
      diary_entries: [
        diaryEntry({ id: 'e1', recorded_at: 'd1', topics: ['friend'], sentiment: 'negative' }),
        diaryEntry({ id: 'e2', recorded_at: 'd2', topics: ['family'], sentiment: 'negative' }),
      ],
    };

    const result = detectSocialWithdrawal(input, 'last_14_days');

    expect(result.detected).toBe(true);
    expect(result.signal).toEqual({
      signal_type: 'social_withdrawal',
      confidence: 89,
      time_window: 'last_14_days',
      detected_change: 'Social interactions decreased by 53%',
      user_impact: 'high',
      suggested_action: 'check_in',
      explainability_text:
        'Your social interactions have significantly decreased over the last 14 days. We detected this trend from 2 observations.',
      evidence_count: 2,
      domains_analyzed: ['social'],
      data_points_analyzed: 12, // 10 social points + 2 diary entries
    });
  });

  it('recognizes "social"/"friend"/"family" topic substrings case-insensitively', () => {
    const input: DetectionInput = {
      longitudinal_data_points: [85, 80, 75, 70, 65, 60, 55, 50, 45, 40].map((v, i) =>
        longPoint({ id: `s${i}`, domain: 'social', key: 'strength', numeric_value: v, recorded_at: `d${i}` })
      ),
      diary_entries: [
        diaryEntry({ id: 'e1', recorded_at: 'd1', topics: ['SOCIAL Life'], sentiment: 'negative' }),
        diaryEntry({ id: 'e2', recorded_at: 'd2', topics: ['My Friend Group'], sentiment: 'negative' }),
      ],
    };
    const result = detectSocialWithdrawal(input, 'last_14_days');
    expect(result.detected).toBe(true);
    expect(result.signal!.evidence_count).toBe(2);
  });
});

describe('detectPositiveMomentum', () => {
  it('is not detected with no input data', () => {
    expect(detectPositiveMomentum({}, 'last_14_days').detected).toBe(false);
  });

  it('is not detected with only 1 evidence source, even at high confidence (evidence-count gate)', () => {
    const input: DetectionInput = {
      vitana_scores: [50, 53, 56, 59, 62, 65, 68, 71].map((s, i) => vitanaScore(`v${i}`, `d${i}`, s)),
    };
    expect(detectPositiveMomentum(input, 'last_14_days').detected).toBe(false);
  });

  it('is not detected with 2 evidence sources when overall confidence stays below 70', () => {
    const input: DetectionInput = {
      vitana_scores: [50, 53, 57, 62, 68].map((s, i) => vitanaScore(`v${i}`, `d${i}`, s)), // confidence 69
      diary_entries: [3, 3.3, 3.6, 4].map((m, i) =>
        diaryEntry({ id: `e${i}`, recorded_at: `d${i}`, mood_score: m })
      ),
    };
    const result = detectPositiveMomentum(input, 'last_14_days');
    expect(result.detected).toBe(false);
  });

  it('detects positive momentum from a strong vitana-score improvement plus corroborating mood improvement', () => {
    const input: DetectionInput = {
      vitana_scores: [50, 53, 56, 59, 62, 65, 68, 71].map((s, i) => vitanaScore(`v${i}`, `d${i}`, s)), // confidence 84, magnitude 42
      diary_entries: [3, 3.3, 3.6, 4].map((m, i) =>
        diaryEntry({ id: `e${i}`, recorded_at: `d${i}`, mood_score: m })
      ),
    };

    const result = detectPositiveMomentum(input, 'last_14_days');

    expect(result.detected).toBe(true);
    expect(result.signal).toEqual({
      signal_type: 'positive_momentum',
      confidence: 84,
      time_window: 'last_14_days',
      detected_change: 'Positive trends across 2 areas',
      user_impact: 'low', // always hardcoded low, regardless of magnitude/confidence
      suggested_action: 'awareness', // always hardcoded
      explainability_text:
        'Great news! Positive trends detected over the last 14 days. We saw noticeably improvements across 2 areas.',
      evidence_count: 2,
      domains_analyzed: ['health', 'engagement', 'social'], // always this fixed list
      data_points_analyzed: 12, // 8 vitana scores + 4 diary entries + 0 engagement points
    });
  });

  it('requires engagement magnitude >= 15 (stricter than the mood/vitana branches\' >= 10) to count as evidence', () => {
    const strongVitana: DetectionInput['vitana_scores'] = [50, 53, 56, 59, 62, 65, 68, 71].map((s, i) =>
      vitanaScore(`v${i}`, `d${i}`, s)
    );

    const belowThreshold: DetectionInput = {
      vitana_scores: strongVitana,
      longitudinal_data_points: [100, 106, 112].map((v, i) =>
        longPoint({ id: `g${i}`, domain: 'engagement', key: 'e', numeric_value: v, recorded_at: `d${i}` })
      ), // magnitude 12 — increasing, but below the 15 threshold
    };
    expect(detectPositiveMomentum(belowThreshold, 'last_14_days').detected).toBe(false); // only 1 evidence source (vitana)

    const atThreshold: DetectionInput = {
      vitana_scores: strongVitana,
      longitudinal_data_points: [10, 13, 17, 22, 28].map((v, i) =>
        longPoint({ id: `g${i}`, domain: 'engagement', key: 'e', numeric_value: v, recorded_at: `d${i}` })
      ), // magnitude 100 — clears the 15 threshold
    };
    const result = detectPositiveMomentum(atThreshold, 'last_14_days');
    expect(result.detected).toBe(true);
    expect(result.signal!.evidence_count).toBe(2);
    expect(result.signal!.data_points_analyzed).toBe(13); // 8 vitana + 0 diary + 5 engagement
  });
});

describe('detectRoutineInstability', () => {
  it('is not detected with no input data', () => {
    expect(detectRoutineInstability({}, 'last_14_days').detected).toBe(false);
  });

  it('is not detected when energy levels are consistent (coefficient of variation at or below 0.3)', () => {
    const input: DetectionInput = {
      diary_entries: [5, 5, 6, 5, 5].map((e, i) => diaryEntry({ id: `e${i}`, recorded_at: `d${i}`, energy_level: e })),
    };
    expect(detectRoutineInstability(input, 'last_14_days').detected).toBe(false);
  });

  it('is not detected with only 1 evidence source (diary variance alone), despite meeting the confidence floor', () => {
    const input: DetectionInput = {
      diary_entries: [2, 9, 3, 8, 2].map((e, i) => diaryEntry({ id: `e${i}`, recorded_at: `d${i}`, energy_level: e })),
    };
    const result = detectRoutineInstability(input, 'last_14_days');
    expect(result.detected).toBe(false); // evidence_count would be 1 < MIN_EVIDENCE_SOURCES(2)
  });

  it('detects routine instability from high energy-level variance plus corroborating engagement variance', () => {
    const input: DetectionInput = {
      diary_entries: [2, 9, 3, 8, 2].map((e, i) => diaryEntry({ id: `e${i}`, recorded_at: `d${i}`, energy_level: e })), // cv=0.6375 -> magnitude 64, confidence 70
      longitudinal_data_points: [10, 25, 8, 22, 9].map((v, i) =>
        longPoint({ id: `g${i}`, domain: 'engagement', key: 'e', numeric_value: v, recorded_at: `d${i}` })
      ), // cv=0.486 -> also clears the 0.25 engagement threshold
    };

    const result = detectRoutineInstability(input, 'last_14_days');

    expect(result.detected).toBe(true);
    expect(result.signal).toEqual({
      signal_type: 'routine_instability',
      confidence: 70,
      time_window: 'last_14_days',
      detected_change: 'Routine patterns vary by 64%',
      user_impact: 'medium',
      suggested_action: 'reflection',
      explainability_text:
        'Your regular routines appear less stable than usual over the last 14 days. This is based on 2 data points showing more variation.',
      evidence_count: 2,
      domains_analyzed: ['engagement', 'health'],
      data_points_analyzed: 10, // 5 diary entries + 5 engagement points
    });
  });

  it("uses a lower coefficient-of-variation threshold for engagement (>0.25) than for diary energy (>0.3), independently gated", () => {
    const input: DetectionInput = {
      diary_entries: [2, 9, 3, 8, 2].map((e, i) => diaryEntry({ id: `e${i}`, recorded_at: `d${i}`, energy_level: e })), // triggers instabilityDetected
      longitudinal_data_points: [5, 8, 4, 7, 5].map((v, i) =>
        longPoint({ id: `g${i}`, domain: 'engagement', key: 'e', numeric_value: v, recorded_at: `d${i}` })
      ), // cv≈0.253 — above engagement's 0.25 threshold but BELOW diary's 0.3 threshold
    };

    const result = detectRoutineInstability(input, 'last_14_days');

    expect(result.detected).toBe(true);
    expect(result.signal!.evidence_count).toBe(2); // engagement's own evidence WAS added despite cv < 0.3
  });
});

// ===========================================================================
// 3. Public RPC-backed API
// ===========================================================================

describe('createSignal', () => {
  const request: CreateSignalRequest = {
    signal_type: 'health_drift',
    confidence: 80,
    time_window: 'last_14_days',
    detected_change: 'x',
    user_impact: 'medium',
    suggested_action: 'reflection',
    explainability_text: 'y',
    evidence_count: 2,
    detection_source: 'engine',
    domains_analyzed: ['health'],
    data_points_analyzed: 5,
    linked_memory_refs: [],
    linked_health_refs: [],
    linked_context_refs: [],
  };

  it('returns UNAUTHENTICATED and never calls the RPC when unauthenticated', async () => {
    const result = await createSignal(request);
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    const rpcCalls = supabaseMock.calls.filter((c) => c.type === 'rpc');
    expect(rpcCalls).toHaveLength(0);
  });

  it('calls d44_create_signal with the request wrapped as p_signal', async () => {
    supabaseMock.setRpc('d44_create_signal', { data: { ok: true, id: 'sig-1', expires_at: 'exp' }, error: null });

    await createSignal(request, 'jwt');

    const call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_create_signal') as any;
    expect(call.params).toEqual({ p_signal: request });
  });

  it('on RPC error: returns ok:false without emitting an event', async () => {
    supabaseMock.setRpc('d44_create_signal', { data: null, error: { message: 'db down' } });

    const result = await createSignal(request, 'jwt');

    expect(result).toEqual({ ok: false, error: 'db down' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('on data.ok=false: returns the mapped error (or CREATION_FAILED fallback) without emitting an event', async () => {
    supabaseMock.setRpc('d44_create_signal', { data: { ok: false }, error: null });

    const result = await createSignal(request, 'jwt');

    expect(result).toEqual({ ok: false, error: 'CREATION_FAILED' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('on success: returns signal_id/signal_type/expires_at and emits a d44.signal.created success event', async () => {
    supabaseMock.setRpc('d44_create_signal', { data: { ok: true, id: 'sig-1', expires_at: '2026-08-01T00:00:00Z' }, error: null });

    const result = await createSignal(request, 'jwt');

    expect(result).toEqual({ ok: true, signal_id: 'sig-1', signal_type: 'health_drift', expires_at: '2026-08-01T00:00:00Z' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd44.signal.created',
        status: 'success',
        payload: expect.objectContaining({
          signal_id: 'sig-1',
          signal_type: 'health_drift',
          confidence: 80,
          user_impact: 'medium',
        }),
      })
    );
  });

  it('catches a thrown RPC call and returns ok:false without emitting an event', async () => {
    supabaseMock.setRpc('d44_create_signal', () => {
      throw new Error('network fail');
    });

    const result = await createSignal(request, 'jwt');

    expect(result).toEqual({ ok: false, error: 'network fail' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('getActiveSignals', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await getActiveSignals({ min_confidence: 0, limit: 20 });
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('defaults signal_types/min_confidence/limit when omitted', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: [], error: null });

    await getActiveSignals({} as any, 'jwt');

    const call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_get_active_signals') as any;
    expect(call.params).toEqual({ p_signal_types: null, p_min_confidence: 0, p_limit: 20 });
  });

  it('passes explicit params through unchanged', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: [], error: null });

    await getActiveSignals({ signal_types: ['health_drift'], min_confidence: 75, limit: 3 }, 'jwt');

    const call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_get_active_signals') as any;
    expect(call.params).toEqual({ p_signal_types: ['health_drift'], p_min_confidence: 75, p_limit: 3 });
  });

  it('on RPC error: returns ok:false', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: null, error: { message: 'x' } });
    const result = await getActiveSignals({ min_confidence: 0, limit: 20 }, 'jwt');
    expect(result).toEqual({ ok: false, error: 'x' });
  });

  it('on success: returns signals + count, defaulting to an empty list when data is null', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: null, error: null });
    expect(await getActiveSignals({ min_confidence: 0, limit: 20 }, 'jwt')).toEqual({ ok: true, signals: [], count: 0 });

    supabaseMock.setRpc('d44_get_active_signals', { data: [{ id: 's1' }, { id: 's2' }], error: null });
    expect(await getActiveSignals({ min_confidence: 0, limit: 20 }, 'jwt')).toEqual({
      ok: true,
      signals: [{ id: 's1' }, { id: 's2' }],
      count: 2,
    });
  });

  it('never emits an OASIS event', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: [], error: null });
    await getActiveSignals({ min_confidence: 0, limit: 20 }, 'jwt');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('getSignalDetails', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await getSignalDetails('sig-1');
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('returns SIGNAL_NOT_FOUND when the signal query returns no rows', async () => {
    supabaseMock.setTable('d44_predictive_signals', { data: [], error: null });

    const result = await getSignalDetails('missing-id', 'jwt');

    expect(result).toEqual({ ok: false, error: 'SIGNAL_NOT_FOUND' });
    const call = supabaseMock.calls.find((c) => c.type === 'table' && c.table === 'd44_predictive_signals') as any;
    expect(call.filters).toEqual({ id: 'missing-id' });
  });

  it('returns the query error when the main signal lookup fails', async () => {
    supabaseMock.setTable('d44_predictive_signals', { data: null, error: { message: 'db error' } });

    const result = await getSignalDetails('sig-1', 'jwt');
    expect(result).toEqual({ ok: false, error: 'db error' });
  });

  it('on success: returns signal + evidence + history, scoping the history query to the same signal id', async () => {
    const signalRow = { id: 'sig-1', signal_type: 'health_drift' } as unknown as PredictiveSignal;
    supabaseMock.setTable('d44_predictive_signals', { data: [signalRow], error: null });
    supabaseMock.setRpc('d44_get_signal_evidence', { data: [{ id: 'ev-1' }], error: null });
    supabaseMock.setTable('d44_intervention_history', { data: [{ id: 'hist-1' }], error: null });

    const result = await getSignalDetails('sig-1', 'jwt');

    expect(result).toEqual({ ok: true, signal: signalRow, evidence: [{ id: 'ev-1' }], history: [{ id: 'hist-1' }] });

    const evidenceCall = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_get_signal_evidence') as any;
    expect(evidenceCall.params).toEqual({ p_signal_id: 'sig-1' });

    const historyCall = supabaseMock.calls.find((c) => c.type === 'table' && c.table === 'd44_intervention_history') as any;
    expect(historyCall.filters).toEqual({ signal_id: 'sig-1' });
  });

  it('degrades evidence/history to empty arrays on their own errors, without failing the whole call', async () => {
    const signalRow = { id: 'sig-1' } as unknown as PredictiveSignal;
    supabaseMock.setTable('d44_predictive_signals', { data: [signalRow], error: null });
    supabaseMock.setRpc('d44_get_signal_evidence', { data: null, error: { message: 'evidence down' } });
    supabaseMock.setTable('d44_intervention_history', { data: null, error: { message: 'history down' } });

    const result = await getSignalDetails('sig-1', 'jwt');

    expect(result.ok).toBe(true);
    expect(result.evidence).toEqual([]);
    expect(result.history).toEqual([]);
  });
});

describe('acknowledgeSignal', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await acknowledgeSignal({ signal_id: 'sig-1' });
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('calls d44_update_signal_status with status=acknowledged and feedback (or null)', async () => {
    supabaseMock.setRpc('d44_update_signal_status', { data: { ok: true }, error: null });

    await acknowledgeSignal({ signal_id: 'sig-1' }, 'jwt');
    let call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_update_signal_status') as any;
    expect(call.params).toEqual({ p_signal_id: 'sig-1', p_status: 'acknowledged', p_feedback: null });

    supabaseMock.calls.length = 0;
    await acknowledgeSignal({ signal_id: 'sig-2', feedback: 'helpful' }, 'jwt');
    call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_update_signal_status') as any;
    expect(call.params).toEqual({ p_signal_id: 'sig-2', p_status: 'acknowledged', p_feedback: 'helpful' });
  });

  it('on data.ok=false: returns the mapped error without emitting an event', async () => {
    supabaseMock.setRpc('d44_update_signal_status', { data: { ok: false }, error: null });
    const result = await acknowledgeSignal({ signal_id: 'sig-1' }, 'jwt');
    expect(result).toEqual({ ok: false, error: 'ACKNOWLEDGE_FAILED' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('on success: emits d44.signal.acknowledged with had_feedback reflecting whether feedback was provided', async () => {
    supabaseMock.setRpc('d44_update_signal_status', { data: { ok: true }, error: null });

    const result = await acknowledgeSignal({ signal_id: 'sig-1', feedback: 'ok' }, 'jwt');

    expect(result).toEqual({ ok: true, signal_id: 'sig-1', status: 'acknowledged' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd44.signal.acknowledged',
        status: 'success',
        payload: expect.objectContaining({ signal_id: 'sig-1', had_feedback: true }),
      })
    );
  });

  it('had_feedback is false when no feedback is provided', async () => {
    supabaseMock.setRpc('d44_update_signal_status', { data: { ok: true }, error: null });
    await acknowledgeSignal({ signal_id: 'sig-1' }, 'jwt');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ had_feedback: false }) })
    );
  });
});

describe('dismissSignal', () => {
  it('calls d44_update_signal_status with status=dismissed and reason (or null) as the feedback param', async () => {
    supabaseMock.setRpc('d44_update_signal_status', { data: { ok: true }, error: null });

    await dismissSignal({ signal_id: 'sig-1', reason: 'not relevant' }, 'jwt');

    const call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_update_signal_status') as any;
    expect(call.params).toEqual({ p_signal_id: 'sig-1', p_status: 'dismissed', p_feedback: 'not relevant' });
  });

  it('on success: emits a d44.signal.dismissed INFO event (not success) with had_reason', async () => {
    supabaseMock.setRpc('d44_update_signal_status', { data: { ok: true }, error: null });

    const result = await dismissSignal({ signal_id: 'sig-1' }, 'jwt');

    expect(result).toEqual({ ok: true, signal_id: 'sig-1', status: 'dismissed' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd44.signal.dismissed',
        status: 'info',
        payload: expect.objectContaining({ had_reason: false }),
      })
    );
  });

  it('on data.ok=false: returns DISMISS_FAILED fallback', async () => {
    supabaseMock.setRpc('d44_update_signal_status', { data: { ok: false }, error: null });
    const result = await dismissSignal({ signal_id: 'sig-1' }, 'jwt');
    expect(result).toEqual({ ok: false, error: 'DISMISS_FAILED' });
  });
});

describe('recordIntervention', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await recordIntervention({ signal_id: 'sig-1', action_type: 'acknowledged', action_details: {} });
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('calls d44_record_intervention with signal id/action type/details', async () => {
    supabaseMock.setRpc('d44_record_intervention', { data: { ok: true, id: 'int-1' }, error: null });

    await recordIntervention({ signal_id: 'sig-1', action_type: 'took_action', action_details: { note: 'x' } }, 'jwt');

    const call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_record_intervention') as any;
    expect(call.params).toEqual({ p_signal_id: 'sig-1', p_action_type: 'took_action', p_action_details: { note: 'x' } });
  });

  it('on success: returns intervention_id and emits a d44.intervention.recorded event', async () => {
    supabaseMock.setRpc('d44_record_intervention', { data: { ok: true, id: 'int-1' }, error: null });

    const result = await recordIntervention({ signal_id: 'sig-1', action_type: 'took_action', action_details: {} }, 'jwt');

    expect(result).toEqual({ ok: true, intervention_id: 'int-1' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd44.intervention.recorded',
        status: 'success',
        payload: expect.objectContaining({ signal_id: 'sig-1', action_type: 'took_action' }),
      })
    );
  });

  it('on data.ok=false: returns INTERVENTION_FAILED fallback without emitting an event', async () => {
    supabaseMock.setRpc('d44_record_intervention', { data: { ok: false }, error: null });
    const result = await recordIntervention({ signal_id: 'sig-1', action_type: 'dismissed', action_details: {} }, 'jwt');
    expect(result).toEqual({ ok: false, error: 'INTERVENTION_FAILED' });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('getSignalStats', () => {
  it('returns UNAUTHENTICATED when unauthenticated', async () => {
    const result = await getSignalStats();
    expect(result).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('passes since through as p_since, or null when omitted', async () => {
    supabaseMock.setRpc('d44_get_signal_stats', { data: { ok: true, total_signals: 0 }, error: null });

    await getSignalStats(undefined, 'jwt');
    let call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_get_signal_stats') as any;
    expect(call.params).toEqual({ p_since: null });

    supabaseMock.calls.length = 0;
    await getSignalStats('2026-01-01', 'jwt');
    call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_get_signal_stats') as any;
    expect(call.params).toEqual({ p_since: '2026-01-01' });
  });

  it('on data.ok=false: returns STATS_FAILED fallback', async () => {
    supabaseMock.setRpc('d44_get_signal_stats', { data: { ok: false }, error: null });
    const result = await getSignalStats(undefined, 'jwt');
    expect(result).toEqual({ ok: false, error: 'STATS_FAILED' });
  });

  it('on success: maps every stats field through, and never emits an OASIS event', async () => {
    supabaseMock.setRpc('d44_get_signal_stats', {
      data: {
        ok: true,
        total_signals: 10,
        active_signals: 3,
        acknowledged_signals: 4,
        dismissed_signals: 3,
        high_impact_signals: 1,
        by_type: { health_drift: 2 },
        avg_confidence: 77.5,
        since: '2026-01-01',
      },
      error: null,
    });

    const result = await getSignalStats('2026-01-01', 'jwt');

    expect(result).toEqual({
      ok: true,
      total_signals: 10,
      active_signals: 3,
      acknowledged_signals: 4,
      dismissed_signals: 3,
      high_impact_signals: 1,
      by_type: { health_drift: 2 },
      avg_confidence: 77.5,
      since: '2026-01-01',
    });
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth / dev-identity wiring — isolation guarantee (mirrors D40's pattern)
// ---------------------------------------------------------------------------

describe('auth wiring — authToken vs. dev-sandbox identity', () => {
  it('uses the caller\'s own user client (never the shared dev tenant) whenever an authToken is supplied, even in a dev sandbox', async () => {
    process.env.ENVIRONMENT = 'dev-sandbox';
    supabaseMock.setRpc('d44_get_active_signals', { data: [], error: null });

    await getActiveSignals({ min_confidence: 0, limit: 20 }, 'user-jwt-xyz');

    const [url, key, opts] = mockCreateClient.mock.calls[0];
    expect(url).toBe('http://localhost:54321');
    expect(key).toBe('test-anon-key');
    expect(opts.global.headers.Authorization).toBe('Bearer user-jwt-xyz');
    // No dev_bootstrap_request_context call at all.
    expect(supabaseMock.calls.some((c) => c.type === 'rpc' && c.name === 'dev_bootstrap_request_context')).toBe(false);
  });

  it('bootstraps the fixed dev tenant only when there is no authToken and the process is a dev sandbox', async () => {
    process.env.ENVIRONMENT = 'dev';
    supabaseMock.setRpc('d44_get_active_signals', { data: [], error: null });

    await getActiveSignals({ min_confidence: 0, limit: 20 });

    const bootstrapCall = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'dev_bootstrap_request_context') as any;
    expect(bootstrapCall.params).toEqual({ p_tenant_id: DEV_TENANT_ID, p_active_role: 'developer' });
  });

  it('returns SERVICE_UNAVAILABLE (not a throw) when the client cannot be constructed', async () => {
    delete process.env.SUPABASE_ANON_KEY;
    const result = await getActiveSignals({ min_confidence: 0, limit: 20 }, 'jwt');
    expect(result).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' });
  });
});

// ===========================================================================
// 4. runDetection orchestration
// ===========================================================================

describe('runDetection', () => {
  const strongHealthInput: DetectionInput = {
    vitana_scores: [40, 45, 50, 55, 60, 65, 70, 75, 80, 85].map((s, i) => vitanaScore(`v${i}`, `d${i}`, s)),
    health_features: [50, 55, 60, 65, 70].map((v, i) => healthFeature(`h${i}`, `d${i}`, 'resting_hr', v)),
  };

  it('emits a d44.detection.started event at the start, listing "all" when signal_types is omitted', async () => {
    supabaseMock.setRpc('d44_create_signal', { data: { ok: true, id: 'sig-x' }, error: null });

    await runDetection({}, { time_window: 'last_14_days', force: false }, 'jwt');

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd44.detection.started',
        status: 'info',
        payload: expect.objectContaining({ signal_types: 'all', time_window: 'last_14_days' }),
      })
    );
  });

  it('detects nothing and creates nothing when there is no input data', async () => {
    const result = await runDetection({}, { time_window: 'last_14_days', force: false }, 'jwt');

    expect(result).toMatchObject({ ok: true, signals_detected: 0, signals_created: 0, signals_skipped: 0 });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'd44.detection.completed', status: 'success' })
    );
  });

  it('silently skips a requested signal_type that has no implemented detector (no crash, 0 detected)', async () => {
    const result = await runDetection(strongHealthInput, { signal_types: ['behavioral_drift'] as any, time_window: 'last_14_days', force: false }, 'jwt');
    expect(result).toEqual(expect.objectContaining({ ok: true, signals_detected: 0, signals_created: 0, signals_skipped: 0 }));
  });

  it('when signal_types restricts detection to one type, only that detector runs even if other types\' data would also trigger', async () => {
    // strongHealthInput would trigger health_drift; restricting to
    // positive_momentum alone must produce 0 detections (no positive
    // momentum evidence present) rather than 1 (health_drift).
    const result = await runDetection(
      strongHealthInput,
      { signal_types: ['positive_momentum'], time_window: 'last_14_days', force: false },
      'jwt'
    );
    expect(result.signals_detected).toBe(0);
  });

  it('creates a signal via createSignal for each detected type when not rate-limited', async () => {
    supabaseMock.setTable('d44_predictive_signals', { data: [], error: null }); // no recent signals -> not rate-limited
    supabaseMock.setRpc('d44_create_signal', { data: { ok: true, id: 'sig-hd' }, error: null });

    const result = await runDetection(
      strongHealthInput,
      { signal_types: ['health_drift'], time_window: 'last_14_days', force: false },
      'jwt'
    );

    expect(result).toMatchObject({ ok: true, signals_detected: 1, signals_created: 1, signals_skipped: 0 });
    const createCall = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_create_signal') as any;
    expect(createCall.params.p_signal.signal_type).toBe('health_drift');
  });

  it('rate-limits: skips creation when a recent signal of that type already exists and force is not set', async () => {
    supabaseMock.setTable('d44_predictive_signals', { data: [{ id: 'existing' }], error: null }); // recent signal present

    const result = await runDetection(
      strongHealthInput,
      { signal_types: ['health_drift'], time_window: 'last_14_days', force: false },
      'jwt'
    );

    expect(result).toMatchObject({ signals_detected: 1, signals_created: 0, signals_skipped: 1 });
    const createCall = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_create_signal');
    expect(createCall).toBeUndefined();

    const rateLimitCall = supabaseMock.calls.find((c) => c.type === 'table' && c.table === 'd44_predictive_signals') as any;
    expect(rateLimitCall.filters).toMatchObject({ signal_type: 'health_drift' });
  });

  it('force=true bypasses the rate-limit check entirely (no d44_predictive_signals lookup) and always creates', async () => {
    supabaseMock.setTable('d44_predictive_signals', { data: [{ id: 'existing' }], error: null }); // would otherwise rate-limit
    supabaseMock.setRpc('d44_create_signal', { data: { ok: true, id: 'sig-forced' }, error: null });

    const result = await runDetection(
      strongHealthInput,
      { signal_types: ['health_drift'], time_window: 'last_14_days', force: true },
      'jwt'
    );

    expect(result).toMatchObject({ signals_detected: 1, signals_created: 1, signals_skipped: 0 });
    const rateLimitCall = supabaseMock.calls.find((c) => c.type === 'table' && c.table === 'd44_predictive_signals');
    expect(rateLimitCall).toBeUndefined();
  });

  it('emits a d44.detection.completed success event summarizing detected/created/skipped counts', async () => {
    supabaseMock.setTable('d44_predictive_signals', { data: [], error: null });
    supabaseMock.setRpc('d44_create_signal', { data: { ok: true, id: 'sig-hd' }, error: null });

    await runDetection(strongHealthInput, { signal_types: ['health_drift'], time_window: 'last_14_days', force: false }, 'jwt');

    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'd44.detection.completed',
        status: 'success',
        payload: expect.objectContaining({ signals_detected: 1, signals_created: 1, signals_skipped: 0 }),
      })
    );
  });
});

// ===========================================================================
// 5. getSignalContextForOrb
// ===========================================================================

describe('getSignalContextForOrb', () => {
  it('requests high-confidence signals (min_confidence=70, limit=5) from getActiveSignals', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: [], error: null });

    await getSignalContextForOrb('jwt');

    const call = supabaseMock.calls.find((c) => c.type === 'rpc' && c.name === 'd44_get_active_signals') as any;
    expect(call.params).toEqual({ p_signal_types: null, p_min_confidence: 70, p_limit: 5 });
  });

  it('returns null when the underlying call fails', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: null, error: { message: 'x' } });
    expect(await getSignalContextForOrb('jwt')).toBeNull();
  });

  it('returns null when there are no active signals', async () => {
    supabaseMock.setRpc('d44_get_active_signals', { data: [], error: null });
    expect(await getSignalContextForOrb('jwt')).toBeNull();
  });

  it('summarizes high/medium impact counts and flags specific signal types by name', async () => {
    supabaseMock.setRpc('d44_get_active_signals', {
      data: [
        { user_impact: 'high', signal_type: 'health_drift' },
        { user_impact: 'high', signal_type: 'social_withdrawal' },
        { user_impact: 'medium', signal_type: 'routine_instability' },
        { user_impact: 'low', signal_type: 'positive_momentum' },
      ],
      error: null,
    });

    const result = await getSignalContextForOrb('jwt');

    expect(result).not.toBeNull();
    expect(result!.activeSignals).toBe(4);
    expect(result!.context).toContain('2 high-priority signal(s)');
    expect(result!.context).toContain('1 pattern(s) worth being aware of');
    expect(result!.context).toContain('Health metrics are showing a notable trend.');
    expect(result!.context).toContain('Social interactions have decreased recently.');
    expect(result!.context).toContain('Positive trends detected in some areas.');
  });

  it('produces an empty context string (not null) when signals exist but none are high/medium impact or of a flagged type', async () => {
    supabaseMock.setRpc('d44_get_active_signals', {
      data: [{ user_impact: 'low', signal_type: 'preference_shift' }],
      error: null,
    });

    const result = await getSignalContextForOrb('jwt');

    expect(result).not.toBeNull();
    expect(result!.context).toBe('');
    expect(result!.activeSignals).toBe(1);
  });
});

// ===========================================================================
// Sanity: documented detection-rule constants used throughout the module
// ===========================================================================

describe('DETECTION_THRESHOLDS', () => {
  it('matches the documented hard constraints (persistent >=3/>=7d, confidence >=70, evidence >=2 sources)', () => {
    expect(DETECTION_THRESHOLDS.MIN_OCCURRENCES).toBe(3);
    expect(DETECTION_THRESHOLDS.MIN_DAYS).toBe(7);
    expect(DETECTION_THRESHOLDS.MIN_CONFIDENCE).toBe(70);
    expect(DETECTION_THRESHOLDS.MIN_EVIDENCE_SOURCES).toBe(2);
    expect(DETECTION_THRESHOLDS.MAX_SIGNALS_PER_TYPE_PER_WEEK).toBe(1);
  });
});
