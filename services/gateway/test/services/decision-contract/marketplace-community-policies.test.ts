// VTID-03138 — Phase C.7 + C.8 of the decision-contract refactor.
//
// Locks the contract for marketplace-analyzer + community-user-analyzer
// threshold externalization. Source-level wire-up + behavioural
// fallback/override tests for the most user-visible knobs.

import * as fs from 'fs';
import * as path from 'path';
import {
  detectCanonicalWeaknesses,
  detectOnboardingStage,
} from '../../../src/services/recommendation-engine/analyzers/community-user-analyzer';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
} from '../../../src/services/decision-contract/policy-resolver';

const NOW_ISO = new Date().toISOString();

function seed(key: string, value: unknown) {
  configurePolicyResolverForTests({
    decisionPolicy: [
      {
        policy_key: key,
        tenant_id: null,
        version: 1,
        value_json: value,
        effective_from: NOW_ISO,
        effective_until: null,
      },
    ],
  });
}

describe('VTID-03138 Phase C.8 community-user-analyzer', () => {
  afterEach(() => __resetPolicyResolverForTests());

  describe('detectCanonicalWeaknesses — cold-cache fallback (threshold=80)', () => {
    beforeEach(() => __resetPolicyResolverForTests());

    it('pillar < 80 → flagged as weakness', () => {
      const w = detectCanonicalWeaknesses({
        nutrition: 75, hydration: 100, exercise: 100, sleep: 100, mental: 100,
      } as any);
      expect(w).toContain('nutrition_low');
      expect(w).not.toContain('hydration_low');
    });

    it('pillar ≥ 80 + previous-drop ≥ 10 → flagged as declining', () => {
      const w = detectCanonicalWeaknesses(
        { nutrition: 85, hydration: 100, exercise: 100, sleep: 100, mental: 100 } as any,
        { nutrition: 100, hydration: 100, exercise: 100, sleep: 100, mental: 100 } as any,
      );
      // 100 - 85 = 15 ≥ 10 → declining
      expect(w).toContain('nutrition_low');
    });

    it('pillar ≥ 80 + previous-drop < 10 → not flagged', () => {
      const w = detectCanonicalWeaknesses(
        { nutrition: 95, hydration: 100, exercise: 100, sleep: 100, mental: 100 } as any,
        { nutrition: 100, hydration: 100, exercise: 100, sleep: 100, mental: 100 } as any,
      );
      expect(w).not.toContain('nutrition_low');
    });
  });

  describe('detectCanonicalWeaknesses — resolver override', () => {
    it('seeded threshold=90 catches pillars 85-89 that fallback (80) would miss', () => {
      seed('analyzer.community.pillar_weakness_threshold', 90);
      const w = detectCanonicalWeaknesses({
        nutrition: 85, hydration: 100, exercise: 100, sleep: 100, mental: 100,
      } as any);
      expect(w).toContain('nutrition_low');
    });

    it('seeded decline-drop=5 makes 5-point declines count', () => {
      seed('analyzer.community.decline_trend_drop_points', 5);
      const w = detectCanonicalWeaknesses(
        { nutrition: 95, hydration: 100, exercise: 100, sleep: 100, mental: 100 } as any,
        { nutrition: 100, hydration: 100, exercise: 100, sleep: 100, mental: 100 } as any,
      );
      expect(w).toContain('nutrition_low');
    });
  });

  describe('detectOnboardingStage — cold-cache parity', () => {
    beforeEach(() => __resetPolicyResolverForTests());

    function dateAgo(days: number): Date {
      return new Date(Date.now() - days * 86400000);
    }

    it('day0 / day1 / day3 / day7 / day14 / day30plus boundaries', () => {
      expect(detectOnboardingStage(dateAgo(0))).toBe('day0');
      expect(detectOnboardingStage(dateAgo(2))).toBe('day1');
      expect(detectOnboardingStage(dateAgo(5))).toBe('day3');
      expect(detectOnboardingStage(dateAgo(10))).toBe('day7');
      expect(detectOnboardingStage(dateAgo(20))).toBe('day14');
      expect(detectOnboardingStage(dateAgo(45))).toBe('day30plus');
    });

    it('seeded day14_after_days=21 stretches the day7 window', () => {
      seed('analyzer.community.onboarding_stage.day14_after_days', 21);
      expect(detectOnboardingStage(dateAgo(20))).toBe('day7'); // would be day14 under default
    });
  });
});

describe('VTID-03138 Phase C.7 marketplace-analyzer — source-level wire-up', () => {
  const SRC = path.resolve(
    __dirname,
    '../../../src/services/recommendation-engine/analyzers/marketplace-analyzer.ts',
  );
  let src: string;
  beforeAll(() => { src = fs.readFileSync(SRC, 'utf8'); });

  it('imports POLICY_KEYS + getPolicyResolver', () => {
    expect(src).toMatch(/getPolicyResolver/);
    expect(src).toMatch(/POLICY_KEYS\./);
  });

  it('hot path uses getMarketplaceWeights() snapshot', () => {
    expect(src).toMatch(/getMarketplaceWeights\(\)/);
  });

  it('scoring loop uses w.ingredientRankBase / w.evidenceMultipliers / w.goalMatchBoost', () => {
    expect(src).toMatch(/w\.ingredientRankBase/);
    expect(src).toMatch(/w\.evidenceMultipliers/);
    expect(src).toMatch(/w\.goalMatchBoost/);
  });

  it('TOP_PICKS_PER_USER and PRODUCT_CANDIDATE_LIMIT call sites use accessor', () => {
    expect(src).toMatch(/getMarketplaceWeights\(\)\.topPicksPerUser/);
    expect(src).toMatch(/getMarketplaceWeights\(\)\.productCandidateLimit/);
  });
});
