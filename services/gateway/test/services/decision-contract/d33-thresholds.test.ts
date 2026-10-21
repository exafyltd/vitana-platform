// VTID-03136 — Phase B.7 of the decision-contract refactor.
//
// Locks the contract for D33_THRESHOLDS externalization. Byte-identical
// fallback parity for all 11 keys, resolver-seeded override behaviour,
// and a source-level wire-up assertion that the engine consumer reads
// through `getD33Thresholds()` instead of the literal const.

import * as fs from 'fs';
import * as path from 'path';
import {
  D33_THRESHOLDS_FALLBACK,
  getD33Thresholds,
} from '../../../src/types/availability-readiness';
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

describe('VTID-03136 Phase B.7 D33 readiness thresholds', () => {
  afterEach(() => __resetPolicyResolverForTests());

  describe('cold-cache fallback parity', () => {
    beforeEach(() => __resetPolicyResolverForTests());

    it.each([
      ['READINESS_MONETIZATION_MIN', 0.6],
      ['READINESS_DEEP_FLOW_MIN', 0.5],
      ['READINESS_LIGHT_FLOW_MIN', 0.3],
      ['TIME_IMMEDIATE_MAX', 2],
      ['TIME_SHORT_MAX', 10],
      ['MIN_CONFIDENCE_FOR_ACTION', 50],
      ['FAST_RESPONSE_THRESHOLD', 5],
      ['SLOW_RESPONSE_THRESHOLD', 30],
      ['SHORT_SESSION_THRESHOLD', 2],
      ['LONG_SESSION_THRESHOLD', 15],
      ['OVERRIDE_EXPIRY_MINUTES', 30],
    ] as const)('cold-cache %s == %p', (key, expected) => {
      const t = getD33Thresholds();
      expect(t[key]).toBe(expected);
    });

    it('cold-cache values are byte-identical to D33_THRESHOLDS_FALLBACK', () => {
      const t = getD33Thresholds();
      for (const [key, value] of Object.entries(D33_THRESHOLDS_FALLBACK)) {
        expect(t[key as keyof typeof t]).toBe(value);
      }
    });
  });

  describe('resolver-seeded overrides', () => {
    it('seeded monetization gate at 0.8 wins over fallback 0.6', () => {
      seed('situational.readiness.monetization_min', 0.8);
      expect(getD33Thresholds().READINESS_MONETIZATION_MIN).toBe(0.8);
    });

    it('seeded long session threshold = 30 wins over fallback 15', () => {
      seed('situational.session_length.long_threshold_minutes', 30);
      expect(getD33Thresholds().LONG_SESSION_THRESHOLD).toBe(30);
    });

    it('seeded override expiry = 60 wins over fallback 30', () => {
      seed('situational.override.expiry_minutes', 60);
      expect(getD33Thresholds().OVERRIDE_EXPIRY_MINUTES).toBe(60);
    });
  });

  describe('source-level wire-up — engine consumes via accessor, not the const', () => {
    const ENGINE_PATH = path.resolve(
      __dirname,
      '../../../src/services/d33-availability-readiness-engine.ts',
    );
    let engineSource: string;

    beforeAll(() => {
      engineSource = fs.readFileSync(ENGINE_PATH, 'utf8');
    });

    it('imports getD33Thresholds, not the legacy D33_THRESHOLDS literal', () => {
      expect(engineSource).toMatch(/\bgetD33Thresholds\b/);
    });

    it('has zero remaining `D33_THRESHOLDS.` literal property reads', () => {
      // Allow `getD33Thresholds()` matches; the regex below counts only
      // the pre-B.7 pattern `D33_THRESHOLDS.X`.
      const literal = engineSource.match(/D33_THRESHOLDS\.[A-Z_]+/g) ?? [];
      expect(literal).toEqual([]);
    });
  });
});
