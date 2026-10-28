// VTID-03171 — unit tests for the D39 compatibility-resolver added in
// PR 5c. Mirrors the conflict-pair-resolver test shape from D42.
//
// Contract under test (per PR 5c brief):
//   - Cold fallback returns the exact current D39 scores
//     (byte-identical to the inline scoreMap / compatibilityMap
//     literals at rev 01bc6fd9).
//   - Seeded global rows override fallback per
//     (dimension, profile_value, candidate_value).
//   - Tenant-specific rows override global rows.
//   - Malformed rows are dropped silently.
//   - Expired / future rows are dropped.
//   - All 9 dimensions are reachable through the resolver.
//   - The resolver never throws; cache cold, DB unavailable, or
//     malformed row → fallback / neutral.
//   - Cache reset / warm behaviour matches the conflict-pair pattern.

import {
  getCompatibilityResolver,
  configureCompatibilityResolverForTests,
  __resetCompatibilityResolverForTests,
  COMPATIBILITY_FALLBACK_MATRICES,
} from '../../../src/services/decision-contract';

const NOW_ISO = new Date(Date.now() - 1000).toISOString();
const FUTURE_ISO = new Date(Date.now() + 86_400_000).toISOString();
const PAST_ISO = new Date(Date.now() - 86_400_000).toISOString();

function row(overrides: Partial<{
  dimension: string;
  profile_value: string;
  candidate_value: string;
  score: number;
  tenant_id: string | null;
  version: number;
  effective_from: string;
  effective_until: string | null;
}> = {}) {
  return {
    dimension: 'simplicity',
    profile_value: 'minimalist',
    candidate_value: 'simple',
    score: 0.42,
    tenant_id: null,
    version: 1,
    effective_from: NOW_ISO,
    effective_until: null,
    ...overrides,
  };
}

describe('VTID-03171 D39 CompatibilityResolver', () => {
  afterEach(() => __resetCompatibilityResolverForTests());

  // -----------------------------------------------------------------
  // Cold-cache fallback parity with the d39 service literals.
  // -----------------------------------------------------------------
  describe('cold-cache fallback parity', () => {
    beforeEach(() => __resetCompatibilityResolverForTests());

    it('simplicity scores match the inline scoreMap (all 9 cells)', () => {
      const r = getCompatibilityResolver();
      const cells: Array<[string, string, number]> = [
        ['minimalist',    'simple',   1.0], ['minimalist',    'moderate', 0.6], ['minimalist',    'complex',  0.2],
        ['balanced',      'simple',   0.7], ['balanced',      'moderate', 1.0], ['balanced',      'complex',  0.7],
        ['comprehensive', 'simple',   0.4], ['comprehensive', 'moderate', 0.7], ['comprehensive', 'complex',  1.0],
      ];
      for (const [p, c, expected] of cells) {
        expect(r.getCompatibilityScore('simplicity', p, c)).toBeCloseTo(expected, 5);
      }
    });

    it('premium scores match the inline scoreMap (all 12 cells)', () => {
      const r = getCompatibilityResolver();
      const cells: Array<[string, string, number]> = [
        ['value_focused', 'budget', 1.0],    ['value_focused', 'mid', 0.8],     ['value_focused', 'premium', 0.4],    ['value_focused', 'luxury', 0.2],
        ['quality_balanced', 'budget', 0.6], ['quality_balanced', 'mid', 1.0],  ['quality_balanced', 'premium', 0.8], ['quality_balanced', 'luxury', 0.5],
        ['premium_oriented', 'budget', 0.2], ['premium_oriented', 'mid', 0.5],  ['premium_oriented', 'premium', 1.0], ['premium_oriented', 'luxury', 0.9],
      ];
      for (const [p, c, expected] of cells) {
        expect(r.getCompatibilityScore('premium', p, c)).toBeCloseTo(expected, 5);
      }
    });

    it('aesthetic scores follow the inline if-cascade — diagonals 1.0, compatible 0.7, neutral 0.5, mismatch 0.3', () => {
      const r = getCompatibilityResolver();
      // Diagonals (excluding neutral)
      expect(r.getCompatibilityScore('aesthetic', 'modern',     'modern')).toBe(1.0);
      expect(r.getCompatibilityScore('aesthetic', 'classic',    'classic')).toBe(1.0);
      expect(r.getCompatibilityScore('aesthetic', 'eclectic',   'eclectic')).toBe(1.0);
      expect(r.getCompatibilityScore('aesthetic', 'natural',    'natural')).toBe(1.0);
      expect(r.getCompatibilityScore('aesthetic', 'functional', 'functional')).toBe(1.0);
      // Compatible pairs from compatibilityMap
      expect(r.getCompatibilityScore('aesthetic', 'modern',     'functional')).toBe(0.7);
      expect(r.getCompatibilityScore('aesthetic', 'modern',     'eclectic')).toBe(0.7);
      expect(r.getCompatibilityScore('aesthetic', 'functional', 'modern')).toBe(0.7);
      // Mismatch
      expect(r.getCompatibilityScore('aesthetic', 'modern',     'classic')).toBe(0.3);
      expect(r.getCompatibilityScore('aesthetic', 'eclectic',   'functional')).toBe(0.3);
      // Neutral row + col
      expect(r.getCompatibilityScore('aesthetic', 'neutral',    'modern')).toBe(0.5);
      expect(r.getCompatibilityScore('aesthetic', 'modern',     'neutral')).toBe(0.5);
      expect(r.getCompatibilityScore('aesthetic', 'neutral',    'neutral')).toBe(0.5);
    });

    it('tone scores follow the same shape — diagonal 1.0, compatible 0.7, neutral 0.5, mismatch 0.3', () => {
      const r = getCompatibilityResolver();
      expect(r.getCompatibilityScore('tone', 'technical',    'technical')).toBe(1.0);
      expect(r.getCompatibilityScore('tone', 'technical',    'minimalist')).toBe(0.7); // compat
      expect(r.getCompatibilityScore('tone', 'casual',       'expressive')).toBe(0.7);
      expect(r.getCompatibilityScore('tone', 'technical',    'expressive')).toBe(0.3); // mismatch
      expect(r.getCompatibilityScore('tone', 'neutral',      'casual')).toBe(0.5);
      expect(r.getCompatibilityScore('tone', 'professional', 'neutral')).toBe(0.5);
    });

    it('routine / social / convenience / experience / novelty match their scoreMap literals', () => {
      const r = getCompatibilityResolver();
      // routine
      expect(r.getCompatibilityScore('routine', 'structured', 'fixed')).toBe(1.0);
      expect(r.getCompatibilityScore('routine', 'flexible',   'fixed')).toBe(0.4);
      expect(r.getCompatibilityScore('routine', 'hybrid',     'flexible')).toBe(0.7);
      // social
      expect(r.getCompatibilityScore('social', 'solo_focused',    'large_group')).toBe(0.2);
      expect(r.getCompatibilityScore('social', 'social_oriented', 'large_group')).toBe(1.0);
      expect(r.getCompatibilityScore('social', 'adaptive',        'solo')).toBe(0.5);
      // convenience
      expect(r.getCompatibilityScore('convenience', 'convenience_first',  'high')).toBe(1.0);
      expect(r.getCompatibilityScore('convenience', 'intentional_living', 'low')).toBe(0.8);
      // experience
      expect(r.getCompatibilityScore('experience', 'digital_native',   'physical')).toBe(0.3);
      expect(r.getCompatibilityScore('experience', 'blended',          'hybrid')).toBe(1.0);
      // novelty
      expect(r.getCompatibilityScore('novelty', 'conservative', 'novel')).toBe(0.2);
      expect(r.getCompatibilityScore('novelty', 'explorer',     'novel')).toBe(1.0);
    });

    it('all 9 dimensions are reachable via cold-fallback getCompatibilityMatrix', () => {
      const r = getCompatibilityResolver();
      const dims = [
        'simplicity', 'premium', 'aesthetic', 'tone',
        'routine', 'social', 'convenience', 'experience', 'novelty',
      ];
      for (const d of dims) {
        const m = r.getCompatibilityMatrix(d);
        expect(Object.keys(m).length).toBeGreaterThan(0);
      }
    });

    it('unknown (dim, profile, candidate) → neutral 0.5 default', () => {
      const r = getCompatibilityResolver();
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'totally_new_value')).toBe(0.5);
      expect(r.getCompatibilityScore('totally_new_dim', 'x', 'y')).toBe(0.5);
    });

    it('exposes FALLBACK_MATRICES so consumers can sanity-check cell counts', () => {
      // Cell counts per dimension (matches PR 5b seed shape)
      expect(Object.keys(COMPATIBILITY_FALLBACK_MATRICES)).toHaveLength(9);
      expect(Object.keys(COMPATIBILITY_FALLBACK_MATRICES.simplicity)).toHaveLength(3);
      expect(Object.keys(COMPATIBILITY_FALLBACK_MATRICES.premium)).toHaveLength(3);
      expect(Object.keys(COMPATIBILITY_FALLBACK_MATRICES.aesthetic)).toHaveLength(6);
      expect(Object.keys(COMPATIBILITY_FALLBACK_MATRICES.tone)).toHaveLength(6);
    });
  });

  // -----------------------------------------------------------------
  // Seeded rows override fallback.
  // -----------------------------------------------------------------
  describe('seeded global rows', () => {
    it('a seeded global cell overrides the literal for that cell only', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ dimension: 'simplicity', profile_value: 'minimalist', candidate_value: 'simple', score: 0.42 }),
        ],
      });
      const r = getCompatibilityResolver();
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(0.42);
      // Other cells still come from the literal (the rest of the
      // matrix is unaffected by overriding one cell — the merged
      // matrix layers tenant > global > literal).
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'complex')).toBe(0.2);
      expect(r.getCompatibilityScore('simplicity', 'comprehensive', 'simple')).toBe(0.4);
    });

    it('multiple seeded cells produce the expected merged matrix', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ dimension: 'social', profile_value: 'solo_focused', candidate_value: 'solo',        score: 0.91 }),
          row({ dimension: 'social', profile_value: 'solo_focused', candidate_value: 'large_group', score: 0.05 }),
        ],
      });
      const m = getCompatibilityResolver().getCompatibilityMatrix('social');
      expect(m.solo_focused.solo).toBe(0.91);        // overridden
      expect(m.solo_focused.large_group).toBe(0.05); // overridden
      expect(m.solo_focused.small_group).toBe(0.5);  // literal preserved
    });

    it('a seeded row in an unknown dimension is reachable through getCompatibilityScore', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ dimension: 'color_palette', profile_value: 'warm', candidate_value: 'orange', score: 0.88 }),
        ],
      });
      const r = getCompatibilityResolver();
      expect(r.getCompatibilityScore('color_palette', 'warm', 'orange')).toBe(0.88);
      // Unknown cell in the new dimension → neutral
      expect(r.getCompatibilityScore('color_palette', 'warm', 'blue')).toBe(0.5);
    });
  });

  // -----------------------------------------------------------------
  // Tenant override semantics.
  // -----------------------------------------------------------------
  describe('tenant override + global fallback', () => {
    const TENANT_A = '00000000-0000-0000-0000-0000000000aa';

    it('tenant-specific row overrides global for that tenant only', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ dimension: 'simplicity', profile_value: 'minimalist', candidate_value: 'simple', score: 0.42 }),
          row({ dimension: 'simplicity', profile_value: 'minimalist', candidate_value: 'simple', score: 0.99, tenant_id: TENANT_A }),
        ],
      });
      const r = getCompatibilityResolver();
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'simple', { tenantId: TENANT_A })).toBe(0.99);
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(0.42);
      // Other tenants don't see TENANT_A's override
      expect(
        r.getCompatibilityScore('simplicity', 'minimalist', 'simple', { tenantId: 'some-other-tenant' }),
      ).toBe(0.42);
    });

    it('tenant query falls back to global for cells the tenant did not override', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ dimension: 'simplicity', profile_value: 'minimalist', candidate_value: 'simple', score: 0.42 }),
          row({ dimension: 'simplicity', profile_value: 'minimalist', candidate_value: 'complex', score: 0.11, tenant_id: TENANT_A }),
        ],
      });
      const r = getCompatibilityResolver();
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'complex', { tenantId: TENANT_A })).toBe(0.11);
      // tenant didn't touch the "simple" cell → falls through to global
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'simple', { tenantId: TENANT_A })).toBe(0.42);
      // tenant also didn't touch "moderate" cell, no global override → falls through to literal
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'moderate', { tenantId: TENANT_A })).toBe(0.6);
    });

    it('getCompatibilityMatrix merges literal < global < tenant', () => {
      configureCompatibilityResolverForTests({
        rows: [
          // global override
          row({ dimension: 'social', profile_value: 'solo_focused', candidate_value: 'solo', score: 0.42 }),
          // tenant override
          row({ dimension: 'social', profile_value: 'solo_focused', candidate_value: 'small_group', score: 0.88, tenant_id: TENANT_A }),
        ],
      });
      const m = getCompatibilityResolver().getCompatibilityMatrix('social', { tenantId: TENANT_A });
      expect(m.solo_focused.solo).toBe(0.42);        // global override visible to tenant
      expect(m.solo_focused.small_group).toBe(0.88); // tenant override
      expect(m.solo_focused.large_group).toBe(0.2);  // literal
    });
  });

  // -----------------------------------------------------------------
  // Malformed-row + time-window guards.
  // -----------------------------------------------------------------
  describe('malformed-row defensive guard', () => {
    it('drops rows with score outside [0, 1]', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ score: 1.5 } as any), // invalid
          row({ score: -0.1, candidate_value: 'moderate' } as any), // invalid
        ],
      });
      const r = getCompatibilityResolver();
      // Both rows dropped → fall through to literal
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'moderate')).toBe(0.6);
    });

    it('drops rows with non-string keys or empty strings', () => {
      configureCompatibilityResolverForTests({
        rows: [
          { dimension: '', profile_value: 'p', candidate_value: 'c', score: 0.5, tenant_id: null, version: 1, effective_from: NOW_ISO, effective_until: null } as any,
          { dimension: 'd', profile_value: '', candidate_value: 'c', score: 0.5, tenant_id: null, version: 1, effective_from: NOW_ISO, effective_until: null } as any,
          { dimension: 'd', profile_value: 'p', candidate_value: '', score: 0.5, tenant_id: null, version: 1, effective_from: NOW_ISO, effective_until: null } as any,
        ],
      });
      // All three dropped → fallback unchanged
      expect(getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
    });

    it('drops rows with unparseable effective_from / effective_until', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ effective_from: 'not a timestamp' } as any),
          row({ effective_until: 'not a timestamp', candidate_value: 'complex' } as any),
        ],
      });
      expect(getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
    });

    it('drops rows with non-integer or non-positive version', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ version: 0 } as any),
          row({ version: 1.5, candidate_value: 'moderate' } as any),
          row({ version: -1, candidate_value: 'complex' } as any),
        ],
      });
      expect(getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
    });
  });

  describe('effective window guard', () => {
    it('drops rows with effective_from in the future', () => {
      configureCompatibilityResolverForTests({
        rows: [row({ effective_from: FUTURE_ISO, score: 0.42 })],
      });
      // The future row is filtered → literal kicks in
      expect(getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
    });

    it('drops rows whose effective_until is in the past', () => {
      configureCompatibilityResolverForTests({
        rows: [row({ effective_until: PAST_ISO, score: 0.42 })],
      });
      expect(getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
    });
  });

  // -----------------------------------------------------------------
  // Version supersession.
  // -----------------------------------------------------------------
  describe('version supersession', () => {
    it('highest version per (dim, profile, candidate) wins', () => {
      configureCompatibilityResolverForTests({
        rows: [
          row({ version: 1, score: 0.42 }),
          row({ version: 2, score: 0.77 }),
          row({ version: 3, score: 0.13 }),
        ],
      });
      expect(getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(0.13);
    });
  });

  // -----------------------------------------------------------------
  // Never-throws semantics.
  // -----------------------------------------------------------------
  describe('never-throws semantics', () => {
    it('cache cold → returns fallback without throwing', () => {
      __resetCompatibilityResolverForTests();
      expect(() =>
        getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple'),
      ).not.toThrow();
    });

    it('cache cold getCompatibilityMatrix returns the literal grid', () => {
      __resetCompatibilityResolverForTests();
      const m = getCompatibilityResolver().getCompatibilityMatrix('aesthetic');
      expect(m.modern.modern).toBe(1.0);
      expect(m.neutral.classic).toBe(0.5);
    });

    it('empty seed → fallback (no rows in DB equivalent to "table missing")', () => {
      configureCompatibilityResolverForTests({ rows: [] });
      expect(getCompatibilityResolver().getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
    });
  });

  // -----------------------------------------------------------------
  // Cache reset / warm interactions.
  // -----------------------------------------------------------------
  describe('cache reset + warm', () => {
    it('__resetCompatibilityResolverForTests clears the cache', () => {
      configureCompatibilityResolverForTests({
        rows: [row({ score: 0.42 })],
      });
      const r = getCompatibilityResolver();
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(0.42);
      __resetCompatibilityResolverForTests();
      // After reset, falls back to literal
      expect(r.getCompatibilityScore('simplicity', 'minimalist', 'simple')).toBe(1.0);
    });
  });
});
