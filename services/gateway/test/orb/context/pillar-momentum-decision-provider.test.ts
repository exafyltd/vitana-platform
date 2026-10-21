/**
 * VTID-02955 (B5) — pillar-momentum-decision-provider adapter tests.
 *
 * Wall: the adapter MUST distill to decision-grade enums and drop:
 *   - raw pillar scores (0..200)
 *   - latest_score field
 *   - recent_window_days field
 *   - history dates
 *
 * Kept: stable pillar enums + momentum bands + confidence + warnings.
 *
 * NEVER carries medical interpretation, diagnoses, or treatment
 * advice.
 */

import {
  computeDecisionWarnings,
  distillPillarMomentumForDecision,
} from '../../../src/orb/context/providers/pillar-momentum-decision-provider';
import type { PillarMomentumContext } from '../../../src/services/pillar-momentum/types';

function makeContext(over: Partial<PillarMomentumContext> = {}): PillarMomentumContext {
  return {
    per_pillar: [
      { pillar: 'sleep',     momentum: 'unknown', latest_score: null, recent_window_days: 0 },
      { pillar: 'nutrition', momentum: 'unknown', latest_score: null, recent_window_days: 0 },
      { pillar: 'exercise',  momentum: 'unknown', latest_score: null, recent_window_days: 0 },
      { pillar: 'hydration', momentum: 'unknown', latest_score: null, recent_window_days: 0 },
      { pillar: 'mental',    momentum: 'unknown', latest_score: null, recent_window_days: 0 },
    ],
    weakest_pillar: null,
    strongest_pillar: null,
    suggested_focus: null,
    confidence: 'low',
    history_days_sampled: 0,
    source_health: {
      vitana_index_scores: { ok: true },
    },
    ...over,
  };
}

describe('B5 — distillPillarMomentumForDecision', () => {
  describe('forbidden raw fields are NOT surfaced', () => {
    it('drops latest_score and recent_window_days from per_pillar entries', () => {
      const out = distillPillarMomentumForDecision({
        pillarMomentum: makeContext({
          per_pillar: [
            { pillar: 'sleep',     momentum: 'improving', latest_score: 100, recent_window_days: 7 },
            { pillar: 'nutrition', momentum: 'steady',    latest_score: 80,  recent_window_days: 7 },
            { pillar: 'exercise',  momentum: 'slipping',  latest_score: 70,  recent_window_days: 7 },
            { pillar: 'hydration', momentum: 'unknown',   latest_score: 90,  recent_window_days: 0 },
            { pillar: 'mental',    momentum: 'steady',    latest_score: 110, recent_window_days: 7 },
          ],
        }),
      });
      expect(out.per_pillar).toHaveLength(5);
      for (const entry of out.per_pillar) {
        const keys = Object.keys(entry).sort();
        expect(keys).toEqual(['momentum', 'pillar']);
        expect((entry as any).latest_score).toBeUndefined();
        expect((entry as any).recent_window_days).toBeUndefined();
      }
    });

    it('top-level shape is exactly the decision-grade keys', () => {
      const out = distillPillarMomentumForDecision({
        pillarMomentum: makeContext({
          weakest_pillar: 'sleep',
          strongest_pillar: 'mental',
          suggested_focus: 'sleep',
        }),
      });
      const keys = Object.keys(out).sort();
      expect(keys).toEqual([
        'confidence',
        'per_pillar',
        'strongest_pillar',
        'suggested_focus',
        'warnings',
        'weakest_pillar',
      ]);
      // History-related fields from the operator view stay out.
      expect((out as any).history_days_sampled).toBeUndefined();
      expect((out as any).source_health).toBeUndefined();
    });
  });

  describe('confidence pass-through', () => {
    it('preserves the compiler-assigned confidence band', () => {
      expect(distillPillarMomentumForDecision({
        pillarMomentum: makeContext({ confidence: 'high' }),
      }).confidence).toBe('high');
      expect(distillPillarMomentumForDecision({
        pillarMomentum: makeContext({ confidence: 'medium' }),
      }).confidence).toBe('medium');
      expect(distillPillarMomentumForDecision({
        pillarMomentum: makeContext({ confidence: 'low' }),
      }).confidence).toBe('low');
    });
  });

  describe('computeDecisionWarnings', () => {
    it('emits low_pillar_confidence when compiler confidence is low', () => {
      expect(computeDecisionWarnings(makeContext({ confidence: 'low' })))
        .toContain('low_pillar_confidence');
    });

    it('does NOT emit low_pillar_confidence when confidence is high', () => {
      expect(computeDecisionWarnings(makeContext({
        confidence: 'high',
        per_pillar: [
          { pillar: 'sleep',     momentum: 'improving', latest_score: 100, recent_window_days: 7 },
          { pillar: 'nutrition', momentum: 'steady',    latest_score: 80,  recent_window_days: 7 },
          { pillar: 'exercise',  momentum: 'steady',    latest_score: 80,  recent_window_days: 7 },
          { pillar: 'hydration', momentum: 'steady',    latest_score: 80,  recent_window_days: 7 },
          { pillar: 'mental',    momentum: 'steady',    latest_score: 80,  recent_window_days: 7 },
        ],
      }))).not.toContain('low_pillar_confidence');
    });

    it('emits no_recent_pillar_data when every pillar is unknown', () => {
      expect(computeDecisionWarnings(makeContext({}))).toContain('no_recent_pillar_data');
    });

    it('does NOT emit no_recent_pillar_data when at least one pillar has a band', () => {
      expect(computeDecisionWarnings(makeContext({
        confidence: 'medium',
        per_pillar: [
          { pillar: 'sleep',     momentum: 'improving', latest_score: 100, recent_window_days: 7 },
          { pillar: 'nutrition', momentum: 'unknown',   latest_score: null, recent_window_days: 0 },
          { pillar: 'exercise',  momentum: 'unknown',   latest_score: null, recent_window_days: 0 },
          { pillar: 'hydration', momentum: 'unknown',   latest_score: null, recent_window_days: 0 },
          { pillar: 'mental',    momentum: 'unknown',   latest_score: null, recent_window_days: 0 },
        ],
      }))).not.toContain('no_recent_pillar_data');
    });

    it('warnings are enum-only (no free-text leaks)', () => {
      const out = distillPillarMomentumForDecision({
        pillarMomentum: makeContext({}),
      });
      for (const w of out.warnings) {
        expect(['low_pillar_confidence', 'no_recent_pillar_data']).toContain(w);
      }
    });
  });
});
