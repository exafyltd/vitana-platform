// VTID-03142 — Phase D42 of the decision-contract refactor.
//
// Locks the contract for the per-conflict-type domain pair map served
// by `getConflictPairResolver`. Covers cold-cache fallback, seeded
// rows, tenant override + global fallback merge, version bump, and
// effective_from / effective_until windows.

import {
  getConflictPairResolver,
  configureConflictPairResolverForTests,
  __resetConflictPairResolverForTests,
} from '../../../src/services/decision-contract/conflict-pair-resolver';

const NOW_ISO = new Date(Date.now() - 1000).toISOString();
const FUTURE_ISO = new Date(Date.now() + 86400_000).toISOString();
const PAST_ISO = new Date(Date.now() - 86400_000).toISOString();

function row(overrides: Partial<{
  conflict_type: string;
  domain_a: string;
  domain_b: string;
  tenant_id: string | null;
  version: number;
  effective_from: string;
  effective_until: string | null;
}> = {}) {
  return {
    conflict_type: 'health_vs_monetization',
    domain_a: 'commerce_monetization',
    domain_b: 'health_wellbeing',
    tenant_id: null,
    version: 1,
    effective_from: NOW_ISO,
    effective_until: null,
    ...overrides,
  };
}

describe('VTID-03142 Phase D42 ConflictPairResolver', () => {
  afterEach(() => __resetConflictPairResolverForTests());

  describe('cold-cache fallback', () => {
    beforeEach(() => __resetConflictPairResolverForTests());

    it('with no rows seeded → returns byte-identical fallback map (6 conflict types, 8 pairs)', () => {
      const m = getConflictPairResolver().getConflictPairs();
      expect(Object.keys(m).sort()).toEqual([
        'boundaries_vs_optimization',
        'capacity_vs_demand',
        'goals_vs_desire',
        'health_vs_monetization',
        'learning_vs_availability',
        'rest_vs_social',
      ]);
      const totalPairs = Object.values(m).reduce((s, v) => s + v.length, 0);
      expect(totalPairs).toBe(8);
      // Pairs are alphabetized within each pair (matches seeded-row
      // representation). The consumer at d42-context-fusion-engine.ts:869
      // handles either order, so this is behaviourally byte-identical
      // to the pre-D42 literal.
      expect(m.health_vs_monetization).toEqual([
        ['commerce_monetization', 'health_wellbeing'],
      ]);
      expect(m.boundaries_vs_optimization).toEqual([
        ['commerce_monetization', 'health_wellbeing'],
        ['commerce_monetization', 'social_relationships'],
      ]);
    });
  });

  describe('seeded rows', () => {
    it('global rows override fallback per conflict_type', () => {
      configureConflictPairResolverForTests({
        rows: [
          row({
            conflict_type: 'health_vs_monetization',
            domain_a: 'health_wellbeing',
            domain_b: 'exploration_discovery', // bogus override for test
          }),
        ],
      });
      const m = getConflictPairResolver().getConflictPairs();
      expect(m.health_vs_monetization).toEqual([
        ['health_wellbeing', 'exploration_discovery'],
      ]);
      // Other conflict_types still come from the seeded rows OR fallback;
      // since we only seeded one, the resolver returns just that one
      // (the cache supersedes fallback wholesale once any row exists).
      // This is by design — admins should seed the full set if they
      // touch the table; this test asserts the behaviour.
      expect(Object.keys(m)).toEqual(['health_vs_monetization']);
    });

    it('multiple rows for one conflict_type are grouped together', () => {
      configureConflictPairResolverForTests({
        rows: [
          row({
            conflict_type: 'boundaries_vs_optimization',
            domain_a: 'commerce_monetization',
            domain_b: 'health_wellbeing',
          }),
          row({
            conflict_type: 'boundaries_vs_optimization',
            domain_a: 'commerce_monetization',
            domain_b: 'social_relationships',
          }),
        ],
      });
      const m = getConflictPairResolver().getConflictPairs();
      expect(m.boundaries_vs_optimization).toHaveLength(2);
      // Deterministic order (sorted by domain_a+domain_b)
      expect(m.boundaries_vs_optimization[0]).toEqual([
        'commerce_monetization',
        'health_wellbeing',
      ]);
    });
  });

  describe('version supersession', () => {
    it('highest version per (conflict_type, tenant) wins; older versions hidden', () => {
      configureConflictPairResolverForTests({
        rows: [
          row({ version: 1, domain_a: 'commerce_monetization', domain_b: 'health_wellbeing' }),
          row({ version: 2, domain_a: 'commerce_monetization', domain_b: 'learning_growth' }),
        ],
      });
      const m = getConflictPairResolver().getConflictPairs();
      expect(m.health_vs_monetization).toEqual([
        ['commerce_monetization', 'learning_growth'],
      ]);
    });
  });

  describe('effective_from / effective_until windows', () => {
    it('row with effective_from in the future is ignored', () => {
      configureConflictPairResolverForTests({
        rows: [
          row({ effective_from: FUTURE_ISO }),
        ],
      });
      const m = getConflictPairResolver().getConflictPairs();
      // No effective rows → seeded-but-empty case; cache returns empty
      // map. The accessor falls back to literals only on cold cache.
      // To get the same fallback semantics, an empty map from a seeded
      // cache means "admin intentionally disabled all conflict pairs".
      expect(m).toEqual({});
    });

    it('row with effective_until in the past is ignored', () => {
      configureConflictPairResolverForTests({
        rows: [
          row({ effective_until: PAST_ISO }),
        ],
      });
      const m = getConflictPairResolver().getConflictPairs();
      expect(m).toEqual({});
    });
  });

  describe('tenant override + global fallback', () => {
    const TENANT_A = '00000000-0000-0000-0000-0000000000aa';

    it('tenant-specific rows override only the conflict_type they touch; rest fall back to global', () => {
      configureConflictPairResolverForTests({
        rows: [
          // Global has health_vs_monetization (alphabetical pair order
          // matches the migration seeds)
          row({
            conflict_type: 'health_vs_monetization',
            domain_a: 'commerce_monetization',
            domain_b: 'health_wellbeing',
          }),
          // Tenant A overrides rest_vs_social only
          row({
            conflict_type: 'rest_vs_social',
            domain_a: 'health_wellbeing',
            domain_b: 'exploration_discovery',
            tenant_id: TENANT_A,
          }),
        ],
      });
      const tenant = getConflictPairResolver().getConflictPairs({ tenantId: TENANT_A });
      // Tenant override applied
      expect(tenant.rest_vs_social).toEqual([
        ['health_wellbeing', 'exploration_discovery'],
      ]);
      // Global still visible for health_vs_monetization
      expect(tenant.health_vs_monetization).toEqual([
        ['commerce_monetization', 'health_wellbeing'],
      ]);
    });

    it('global query does NOT see tenant-specific rows', () => {
      configureConflictPairResolverForTests({
        rows: [
          row({
            conflict_type: 'rest_vs_social',
            domain_a: 'health_wellbeing',
            domain_b: 'exploration_discovery',
            tenant_id: TENANT_A,
          }),
          // A neutral global row so the cache isn't "empty" (which would
          // trigger the fallback literals)
          row({
            conflict_type: 'health_vs_monetization',
            domain_a: 'commerce_monetization',
            domain_b: 'health_wellbeing',
          }),
        ],
      });
      const global = getConflictPairResolver().getConflictPairs();
      // Tenant A's rest_vs_social must NOT appear under global scope.
      expect(global.rest_vs_social).toBeUndefined();
      expect(global.health_vs_monetization).toEqual([
        ['commerce_monetization', 'health_wellbeing'],
      ]);
    });
  });
});
