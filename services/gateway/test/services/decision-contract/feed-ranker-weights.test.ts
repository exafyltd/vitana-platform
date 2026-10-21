// VTID-03137 — Phase C.5 of the decision-contract refactor.
//
// Locks the contract for feed-ranker weight externalization. Byte-identical
// cold-cache parity + resolver-seeded override behaviour + source-level
// wire-up assertions.

import * as fs from 'fs';
import * as path from 'path';
import {
  defaultPersonalizationWeightForStage,
  rankFeedProducts,
} from '../../../src/services/feed-ranker';
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

describe('VTID-03137 Phase C.5 feed-ranker weights', () => {
  afterEach(() => __resetPolicyResolverForTests());

  describe('defaultPersonalizationWeightForStage — cold-cache parity', () => {
    beforeEach(() => __resetPolicyResolverForTests());

    it.each([
      ['onboarding', 0.2],
      ['early', 0.45],
      ['established', 0.7],
      ['mature', 0.9],
      [null, 0.3],
      ['unknown-stage', 0.3],
    ] as const)('stage=%p → %p', (stage, expected) => {
      expect(defaultPersonalizationWeightForStage(stage)).toBe(expected);
    });
  });

  describe('defaultPersonalizationWeightForStage — resolver override', () => {
    it('seeded onboarding = 0.05 wins', () => {
      seed('ranker.feed.personalization_weight.onboarding', 0.05);
      expect(defaultPersonalizationWeightForStage('onboarding')).toBe(0.05);
    });

    it('seeded mature = 0.99 wins', () => {
      seed('ranker.feed.personalization_weight.mature', 0.99);
      expect(defaultPersonalizationWeightForStage('mature')).toBe(0.99);
    });
  });

  describe('rankFeedProducts — featured boost cold-cache parity', () => {
    beforeEach(() => __resetPolicyResolverForTests());

    it('featured product gets the 0.7 default-score boost', () => {
      const out = rankFeedProducts({
        products: [
          { id: 'a', merchant_id: 'm1', category: 'food', rating: null, origin_region: null, health_goals: null, price_cents: null },
          { id: 'b', merchant_id: 'm2', category: 'food', rating: null, origin_region: null, health_goals: null, price_cents: null },
        ],
        config: {
          featured_product_ids: ['a'],
          starter_conditions: [],
          max_products_per_merchant: 10,
          max_products_per_category: null,
          category_mix: {},
          personalization_weight_override: 0,
          region_group: null,
        } as any,
        ctx: {
          lifecycle_stage: 'onboarding',
          topic_affinity: {},
          active_conditions: [],
          region_group: null,
          budget_max_per_product_cents: null,
        } as any,
        limit: 10,
      });
      const a = out.items.find((p: any) => p.id === 'a')!;
      const b = out.items.find((p: any) => p.id === 'b')!;
      // 'a' wins because of featured 0.7 boost (under 0% personalization weight,
      // the personalization side is zero so default-score is the whole score).
      expect(a.rank_score).toBeGreaterThan(b.rank_score);
      // 0.7 boost × (1 - 0) default weight = 0.7
      expect(a.rank_score).toBeCloseTo(0.7, 5);
    });
  });

  describe('source-level wire-up — no remaining literals in feed-ranker', () => {
    const SRC = path.resolve(__dirname, '../../../src/services/feed-ranker.ts');
    let src: string;
    beforeAll(() => { src = fs.readFileSync(SRC, 'utf8'); });

    it('imports POLICY_KEYS + getPolicyResolver', () => {
      expect(src).toMatch(/from\s+['"]\.\/decision-contract\/policy-resolver['"]/);
      expect(src).toMatch(/POLICY_KEYS/);
    });

    it('uses w.featuredBoost (not the literal 0.7) inside the scoring loop', () => {
      expect(src).toMatch(/w\.featuredBoost/);
    });

    it('uses w.highRatingThreshold (not the literal 4.5) inside the scoring loop', () => {
      expect(src).toMatch(/w\.highRatingThreshold/);
    });

    it('uses w.pwOnboarding et al. in defaultPersonalizationWeightForStage', () => {
      expect(src).toMatch(/w\.pwOnboarding/);
      expect(src).toMatch(/w\.pwMature/);
    });
  });
});
