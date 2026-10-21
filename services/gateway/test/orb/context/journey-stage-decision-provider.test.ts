/**
 * VTID-02954 (F3) — journey-stage-decision-provider adapter tests.
 *
 * Wall: the adapter MUST distill to decision-grade enums and drop:
 *   - raw tenure_days integer (kept as tenure_bucket enum)
 *   - raw last_active_date ISO string (kept as activity_recency enum)
 *   - raw usage_days_count integer (kept as usage_volume enum)
 *   - raw vitana_index.score_total 0..999 (kept as tier enum)
 *   - raw tier_days_held integer (kept as tier_tenure enum)
 * Kept: bucketed forms only + ExplanationDepthHint (already enum) +
 * derived StageToneHint + JourneyConfidenceBucket + enum-only warnings.
 */

import {
  bucketActivityRecency,
  bucketTierTenure,
  bucketUsageVolume,
  computeJourneyConfidence,
  computeWarnings,
  distillJourneyStageForDecision,
  toneFromStage,
} from '../../../src/orb/context/providers/journey-stage-decision-provider';
import type { JourneyStageContext } from '../../../src/services/journey-stage/types';

function makeContext(over: Partial<JourneyStageContext> = {}): JourneyStageContext {
  return {
    onboarding_stage: 'first_session',
    tenure_days: null,
    usage_days_count: 0,
    last_active_date: null,
    days_since_last_active: null,
    vitana_index: {
      score_total: null,
      tier: 'unknown',
      tier_days_held: null,
    },
    explanation_depth_hint: 'deep',
    source_health: {
      app_users: { ok: true },
      user_active_days: { ok: true },
      vitana_index_scores: { ok: true },
    },
    ...over,
  };
}

describe('F3 — distillJourneyStageForDecision', () => {
  describe('forbidden raw fields are NOT surfaced', () => {
    it('drops raw tenure_days, last_active_date, usage_days_count, score_total, tier_days_held', () => {
      const out = distillJourneyStageForDecision({
        journeyStage: makeContext({
          tenure_days: 42,
          usage_days_count: 25,
          last_active_date: '2026-05-10',
          days_since_last_active: 3,
          vitana_index: {
            score_total: 425,
            tier: 'momentum',
            tier_days_held: 12,
          },
        }),
      });
      // Top-level keys are entirely bucket-based or enums.
      const keys = Object.keys(out).sort();
      expect(keys).toEqual([
        'activity_recency',
        'explanation_depth',
        'journey_confidence',
        'stage',
        'tenure_bucket',
        'tier_tenure',
        'tone_hint',
        'usage_volume',
        'vitana_index_tier',
        'warnings',
      ]);
      // No raw integers / strings smuggled through.
      expect((out as any).tenure_days).toBeUndefined();
      expect((out as any).last_active_date).toBeUndefined();
      expect((out as any).usage_days_count).toBeUndefined();
      expect((out as any).score_total).toBeUndefined();
      expect((out as any).tier_days_held).toBeUndefined();
      expect((out as any).days_since_last_active).toBeUndefined();
    });

    it('frequency-style fields are enums, not numbers', () => {
      const out = distillJourneyStageForDecision({
        journeyStage: makeContext({
          tenure_days: 30,
          usage_days_count: 50,
          days_since_last_active: 1,
          vitana_index: { score_total: 700, tier: 'flourishing', tier_days_held: 100 },
        }),
      });
      expect(typeof out.tier_tenure).toBe('string');
      expect(typeof out.activity_recency).toBe('string');
      expect(typeof out.usage_volume).toBe('string');
      expect(typeof out.vitana_index_tier).toBe('string');
    });
  });

  describe('toneFromStage', () => {
    it.each([
      ['first_session', 'warm_welcoming'],
      ['first_days',    'guiding'],
      ['first_week',    'collaborative'],
      ['first_month',   'collaborative'],
      ['established',   'concise_familiar'],
    ] as const)('%s → %s', (stage, expected) => {
      expect(toneFromStage(stage)).toBe(expected);
    });
  });

  describe('bucketTierTenure', () => {
    it.each([
      [null, 'unknown'],
      [0,    'new'],
      [6,    'new'],
      [7,    'settled'],
      [29,   'settled'],
      [30,   'long_standing'],
      [365,  'long_standing'],
    ] as const)('%s → %s', (days, expected) => {
      expect(bucketTierTenure(days)).toBe(expected);
    });
  });

  describe('bucketActivityRecency', () => {
    it.each([
      [null, 'unknown'],
      [0,    'today'],
      [1,    'today'],
      [2,    'recent'],
      [7,    'recent'],
      [8,    'lapsed'],
      [365,  'lapsed'],
    ] as const)('%s → %s', (days, expected) => {
      expect(bucketActivityRecency(days)).toBe(expected);
    });
  });

  describe('bucketUsageVolume', () => {
    it.each([
      [0,   'none'],
      [-1,  'none'],
      [1,   'light'],
      [7,   'light'],
      [8,   'regular'],
      [30,  'regular'],
      [31,  'heavy'],
      [365, 'heavy'],
    ] as const)('%d → %s', (count, expected) => {
      expect(bucketUsageVolume(count)).toBe(expected);
    });
  });

  describe('computeJourneyConfidence', () => {
    it('high when app_users ok AND active_days has data', () => {
      expect(computeJourneyConfidence(makeContext({
        tenure_days: 30,
        usage_days_count: 10,
      }))).toBe('high');
    });

    it('high when app_users ok AND index has data', () => {
      expect(computeJourneyConfidence(makeContext({
        tenure_days: 30,
        usage_days_count: 0,
        vitana_index: { score_total: 425, tier: 'momentum', tier_days_held: 5 },
      }))).toBe('high');
    });

    it('medium when app_users ok but no supporting data', () => {
      expect(computeJourneyConfidence(makeContext({
        tenure_days: 30,
        usage_days_count: 0,
      }))).toBe('medium');
    });

    it('low when app_users source not ok', () => {
      expect(computeJourneyConfidence(makeContext({
        tenure_days: 30,
        source_health: {
          app_users: { ok: false, reason: 'boom' },
          user_active_days: { ok: true },
          vitana_index_scores: { ok: true },
        },
      }))).toBe('low');
    });

    it('low when tenure_days is null even if sources ok', () => {
      expect(computeJourneyConfidence(makeContext({
        tenure_days: null,
      }))).toBe('low');
    });
  });

  describe('computeWarnings', () => {
    it('emits no_tenure_data when tenure_days is null', () => {
      expect(computeWarnings(makeContext({ tenure_days: null }))).toContain('no_tenure_data');
    });

    it('emits long_inactivity when days_since_last_active > 7', () => {
      expect(computeWarnings(makeContext({
        tenure_days: 30,
        days_since_last_active: 30,
      }))).toContain('long_inactivity');
    });

    it('does NOT emit long_inactivity when days_since_last_active is null', () => {
      expect(computeWarnings(makeContext({
        tenure_days: 30,
        days_since_last_active: null,
      }))).not.toContain('long_inactivity');
    });

    it('emits unknown_tier when vitana_index_tier is unknown', () => {
      expect(computeWarnings(makeContext({}))).toContain('unknown_tier');
    });

    it('warnings are an enum-only array (no free-text)', () => {
      const out = distillJourneyStageForDecision({
        journeyStage: makeContext({
          tenure_days: null,
          days_since_last_active: 30,
        }),
      });
      for (const w of out.warnings) {
        expect(['no_tenure_data', 'long_inactivity', 'unknown_tier']).toContain(w);
      }
    });
  });
});
