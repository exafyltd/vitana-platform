/**
 * Tests for derivePillarImpact — the read-time derivation of
 * (primary_pillar, magnitude) from autopilot_recommendations.contribution_vector.
 *
 * See services/gateway/src/services/recommendation-engine/pillar-impact.ts.
 */

import { derivePillarImpact } from '../src/services/recommendation-engine/pillar-impact';

describe('derivePillarImpact', () => {
  test('returns none for null vector', () => {
    expect(derivePillarImpact(null)).toEqual({ primary_pillar: null, magnitude: 'none' });
  });

  test('returns none for undefined vector', () => {
    expect(derivePillarImpact(undefined)).toEqual({ primary_pillar: null, magnitude: 'none' });
  });

  test('returns none for empty object', () => {
    expect(derivePillarImpact({})).toEqual({ primary_pillar: null, magnitude: 'none' });
  });

  test('returns none for all-zero vector', () => {
    expect(derivePillarImpact({ nutrition: 0, hydration: 0, exercise: 0, sleep: 0, mental: 0 }))
      .toEqual({ primary_pillar: null, magnitude: 'none' });
  });

  test('returns none for max weight below low band (< 0.05)', () => {
    expect(derivePillarImpact({ sleep: 0.04 }))
      .toEqual({ primary_pillar: null, magnitude: 'none' });
  });

  test('classifies low band correctly (0.05 ≤ w < 0.2)', () => {
    expect(derivePillarImpact({ mental: 0.1 }))
      .toEqual({ primary_pillar: 'mental', magnitude: 'low' });
  });

  test('classifies medium band correctly (0.2 ≤ w < 0.5)', () => {
    expect(derivePillarImpact({ exercise: 0.3 }))
      .toEqual({ primary_pillar: 'exercise', magnitude: 'medium' });
  });

  test('classifies high band correctly (w ≥ 0.5)', () => {
    expect(derivePillarImpact({ sleep: 0.7 }))
      .toEqual({ primary_pillar: 'sleep', magnitude: 'high' });
  });

  test('picks the pillar with the highest weight', () => {
    const result = derivePillarImpact({
      nutrition: 0.1,
      hydration: 0.4,
      exercise: 0.2,
      sleep: 0.05,
      mental: 0.6,
    });
    expect(result).toEqual({ primary_pillar: 'mental', magnitude: 'high' });
  });

  test('ignores non-numeric / NaN values', () => {
    expect(derivePillarImpact({ sleep: 'high' as unknown as number, exercise: 0.3 }))
      .toEqual({ primary_pillar: 'exercise', magnitude: 'medium' });
  });

  test('handles string numbers via Number coercion', () => {
    expect(derivePillarImpact({ nutrition: '0.3' as unknown as number }))
      .toEqual({ primary_pillar: 'nutrition', magnitude: 'medium' });
  });

  test('ignores unknown keys outside PILLAR_KEYS', () => {
    expect(derivePillarImpact({ longevity: 0.9, made_up: 1.0 } as Record<string, number>))
      .toEqual({ primary_pillar: null, magnitude: 'none' });
  });

  test('tie-breaks by PILLAR_KEYS iteration order (nutrition wins over hydration on tie)', () => {
    const result = derivePillarImpact({ nutrition: 0.3, hydration: 0.3 });
    expect(result).toEqual({ primary_pillar: 'nutrition', magnitude: 'medium' });
  });
});
