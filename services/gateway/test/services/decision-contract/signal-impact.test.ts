// VTID-03140 — Phase C.6 of the decision-contract refactor.
//
// Locks the contract for the 6 per-signal-type impact catalogues.
// Behavioural fallback (cold cache) + resolver override (seeded row).

import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
} from '../../../src/services/decision-contract/policy-resolver';
import {
  getCodebaseSignalImpact,
  getOasisSignalImpact,
  getHealthSignalImpact,
  getLLMSignalImpact,
  getMarketplaceSignalImpact,
  getWearableSignalImpact,
} from '../../../src/services/recommendation-engine/signal-impact';

const NOW_ISO = new Date().toISOString();

function seedSignalImpact(key: string, payload: unknown) {
  configurePolicyResolverForTests({
    decisionPolicy: [
      {
        policy_key: key,
        tenant_id: null,
        version: 1,
        value_json: payload,
        effective_from: NOW_ISO,
        effective_until: null,
      },
    ],
  });
}

describe('VTID-03140 Phase C.6 signal-impact accessors', () => {
  afterEach(() => __resetPolicyResolverForTests());

  // -----------------------------------------------------------------
  // Cold-cache fallback parity — every value must match the literal it
  // replaces. If any of these change, callers will see different scores.
  // -----------------------------------------------------------------
  describe('cold-cache fallback parity', () => {
    beforeEach(() => __resetPolicyResolverForTests());

    it('codebase impacts match pre-refactor literals', () => {
      expect(getCodebaseSignalImpact('todo')).toBe(5);
      expect(getCodebaseSignalImpact('large_file')).toBe(6);
      expect(getCodebaseSignalImpact('missing_tests')).toBe(7);
      expect(getCodebaseSignalImpact('dead_code')).toBe(4);
      expect(getCodebaseSignalImpact('duplication')).toBe(5);
      expect(getCodebaseSignalImpact('missing_docs')).toBe(3);
    });

    it('codebase unknown key → fallback 5', () => {
      expect(getCodebaseSignalImpact('totally-new-kind')).toBe(5);
    });

    it('oasis impacts match pre-refactor literals', () => {
      expect(getOasisSignalImpact('error_pattern')).toBe(8);
      expect(getOasisSignalImpact('slow_endpoint')).toBe(7);
      expect(getOasisSignalImpact('failed_deploy')).toBe(9);
      expect(getOasisSignalImpact('anomaly')).toBe(6);
      expect(getOasisSignalImpact('underused_feature')).toBe(4);
    });

    it('oasis unknown key → fallback 6', () => {
      expect(getOasisSignalImpact('totally-new-kind')).toBe(6);
    });

    it('health impacts match pre-refactor literals', () => {
      expect(getHealthSignalImpact('missing_index')).toBe(7);
      expect(getHealthSignalImpact('large_table')).toBe(6);
      expect(getHealthSignalImpact('missing_rls')).toBe(9);
      expect(getHealthSignalImpact('env_gap')).toBe(8);
      expect(getHealthSignalImpact('stale_migration')).toBe(5);
    });

    it('health unknown key → fallback 6', () => {
      expect(getHealthSignalImpact('totally-new-kind')).toBe(6);
    });

    it('LLM ladder boundaries match `>0.8 ? 8 : >0.5 ? 6 : 4`', () => {
      expect(getLLMSignalImpact(0.9)).toBe(8);
      expect(getLLMSignalImpact(0.81)).toBe(8);
      expect(getLLMSignalImpact(0.8)).toBe(6); // strictly greater
      expect(getLLMSignalImpact(0.6)).toBe(6);
      expect(getLLMSignalImpact(0.51)).toBe(6);
      expect(getLLMSignalImpact(0.5)).toBe(4); // strictly greater
      expect(getLLMSignalImpact(0.3)).toBe(4);
      expect(getLLMSignalImpact(0)).toBe(4);
    });

    it('marketplace ladder boundaries match `>0.7 ? 8 : >0.5 ? 6 : 4`', () => {
      expect(getMarketplaceSignalImpact(0.9)).toBe(8);
      expect(getMarketplaceSignalImpact(0.71)).toBe(8);
      expect(getMarketplaceSignalImpact(0.7)).toBe(6);
      expect(getMarketplaceSignalImpact(0.6)).toBe(6);
      expect(getMarketplaceSignalImpact(0.51)).toBe(6);
      expect(getMarketplaceSignalImpact(0.5)).toBe(4);
      expect(getMarketplaceSignalImpact(0.1)).toBe(4);
    });

    it('wearable severity ladder matches `high→8, medium→6, low→4`', () => {
      expect(getWearableSignalImpact('high')).toBe(8);
      expect(getWearableSignalImpact('medium')).toBe(6);
      expect(getWearableSignalImpact('low')).toBe(4);
    });
  });

  // -----------------------------------------------------------------
  // Resolver overrides — seed a row, value flows through.
  // -----------------------------------------------------------------
  describe('resolver override', () => {
    it('seeded codebase row overrides built-in fallback', () => {
      seedSignalImpact('recommendation.signal_impact.codebase', {
        version: 1,
        impacts: {
          todo: { impact: 99, weight: 1, rationale: 'test bump' },
          missing_docs: { impact: 9, weight: 1, rationale: 'test bump' },
        },
      });
      expect(getCodebaseSignalImpact('todo')).toBe(99);
      expect(getCodebaseSignalImpact('missing_docs')).toBe(9);
      // Missing keys fall through to the per-key default (5 for codebase)
      // because the override row's `impacts` is sparse.
      expect(getCodebaseSignalImpact('missing_tests')).toBe(5);
    });

    it('seeded LLM ladder overrides built-in tiers', () => {
      seedSignalImpact('recommendation.signal_impact.llm', {
        version: 1,
        impacts: {
          high: { impact: 10, weight: 1, rationale: 'test' },
          mid:  { impact: 7,  weight: 1, rationale: 'test' },
          low:  { impact: 1,  weight: 1, rationale: 'test' },
        },
      });
      expect(getLLMSignalImpact(0.9)).toBe(10);
      expect(getLLMSignalImpact(0.6)).toBe(7);
      expect(getLLMSignalImpact(0.2)).toBe(1);
    });

    it('seeded marketplace ladder overrides built-in tiers', () => {
      seedSignalImpact('recommendation.signal_impact.marketplace', {
        version: 1,
        impacts: {
          high: { impact: 10, weight: 1, rationale: 'test' },
          mid:  { impact: 5,  weight: 1, rationale: 'test' },
          low:  { impact: 1,  weight: 1, rationale: 'test' },
        },
      });
      expect(getMarketplaceSignalImpact(0.9)).toBe(10);
      expect(getMarketplaceSignalImpact(0.6)).toBe(5);
      expect(getMarketplaceSignalImpact(0.2)).toBe(1);
    });

    it('seeded wearable ladder overrides built-in tiers', () => {
      seedSignalImpact('recommendation.signal_impact.wearable', {
        version: 1,
        impacts: {
          high:   { impact: 10, weight: 1, rationale: 'test' },
          medium: { impact: 5,  weight: 1, rationale: 'test' },
          low:    { impact: 1,  weight: 1, rationale: 'test' },
        },
      });
      expect(getWearableSignalImpact('high')).toBe(10);
      expect(getWearableSignalImpact('medium')).toBe(5);
      expect(getWearableSignalImpact('low')).toBe(1);
    });
  });

  // -----------------------------------------------------------------
  // Defensive shape guards — a malformed override must not crash
  // recommendation generation. Fall back to literals instead.
  // -----------------------------------------------------------------
  describe('malformed-policy defensive guard', () => {
    it('row missing impacts → falls back', () => {
      seedSignalImpact('recommendation.signal_impact.codebase', {
        version: 1,
      });
      expect(getCodebaseSignalImpact('missing_tests')).toBe(7);
    });

    it('row with wrong version → falls back', () => {
      seedSignalImpact('recommendation.signal_impact.codebase', {
        version: 2,
        impacts: { missing_tests: { impact: 99, weight: 1, rationale: 'x' } },
      });
      expect(getCodebaseSignalImpact('missing_tests')).toBe(7);
    });

    it('row with impacts entry missing impact field → per-key default', () => {
      seedSignalImpact('recommendation.signal_impact.health', {
        version: 1,
        impacts: { missing_index: { rationale: 'broken' } as never },
      });
      // missing_index entry exists but has no `impact` number → fallback default (6)
      expect(getHealthSignalImpact('missing_index')).toBe(6);
    });
  });
});
