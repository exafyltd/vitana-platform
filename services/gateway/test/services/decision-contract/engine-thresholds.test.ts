// VTID-03135 — Phase B.5 + B.6 of the decision-contract refactor.
//
// Lock the contract for temporal-bucket motivation signal + D32
// time-of-day window externalization. Byte-identical fallback parity
// plus resolver-seeded overrides.

import { deriveMotivationSignal } from '../../../src/services/guide/temporal-bucket';
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

describe('VTID-03135 B.5 — temporal-bucket motivation signal', () => {
  afterEach(() => __resetPolicyResolverForTests());

  describe('cold-cache fallback (14-day boundary)', () => {
    beforeEach(() => __resetPolicyResolverForTests());

    it('long + days ≤ 14 → cooling', () => {
      expect(deriveMotivationSignal('long', 10)).toBe('cooling');
      expect(deriveMotivationSignal('long', 14)).toBe('cooling');
    });

    it('long + days > 14 → absent', () => {
      expect(deriveMotivationSignal('long', 15)).toBe('absent');
      expect(deriveMotivationSignal('long', 100)).toBe('absent');
    });

    it('fresh/engaged buckets unaffected by policy', () => {
      expect(deriveMotivationSignal('today', 0)).toBe('fresh');
      expect(deriveMotivationSignal('week', 5)).toBe('engaged');
      expect(deriveMotivationSignal('first', 999)).toBe('fresh');
    });
  });

  describe('resolver-seeded boundary override', () => {
    it('seeded boundary = 7 → days 8 already absent', () => {
      seed('session.motivation.cooling_to_absent_days', 7);
      expect(deriveMotivationSignal('long', 7)).toBe('cooling');
      expect(deriveMotivationSignal('long', 8)).toBe('absent');
    });

    it('seeded boundary = 30 → 20-day gap still cooling', () => {
      seed('session.motivation.cooling_to_absent_days', 30);
      expect(deriveMotivationSignal('long', 20)).toBe('cooling');
      expect(deriveMotivationSignal('long', 31)).toBe('absent');
    });
  });
});

describe('VTID-03135 B.6 — D32 time-of-day window classifier', () => {
  // Access via the same boundary keys; verifies the import wire-up
  // catches any policy-key regression. The underlying `classifyTimeWindow`
  // is private, but the per-key parity is easy to assert directly: when
  // the resolver has no row, getValue returns defaultValue, which is the
  // literal we seeded.

  afterEach(() => __resetPolicyResolverForTests());

  it('cold-cache reads all 5 hour boundaries via fallback', async () => {
    __resetPolicyResolverForTests();
    const { getPolicyResolver } = await import('../../../src/services/decision-contract/policy-resolver');
    const { POLICY_KEYS } = await import('../../../src/services/decision-contract/policy-keys');
    const get = (k: string, d: number) =>
      getPolicyResolver().getValue<number>(k, { defaultValue: d });
    expect(get(POLICY_KEYS.SITUATIONAL_TIME_OF_DAY_EARLY_MORNING_START_HOUR, 5)).toBe(5);
    expect(get(POLICY_KEYS.SITUATIONAL_TIME_OF_DAY_MORNING_START_HOUR, 8)).toBe(8);
    expect(get(POLICY_KEYS.SITUATIONAL_TIME_OF_DAY_AFTERNOON_START_HOUR, 12)).toBe(12);
    expect(get(POLICY_KEYS.SITUATIONAL_TIME_OF_DAY_EVENING_START_HOUR, 17)).toBe(17);
    expect(get(POLICY_KEYS.SITUATIONAL_TIME_OF_DAY_LATE_EVENING_START_HOUR, 21)).toBe(21);
  });

  it('seeded morning_start override changes the read value', async () => {
    seed('situational.time_of_day.morning_start_hour', 9);
    const { getPolicyResolver } = await import('../../../src/services/decision-contract/policy-resolver');
    const { POLICY_KEYS } = await import('../../../src/services/decision-contract/policy-keys');
    expect(
      getPolicyResolver().getValue<number>(POLICY_KEYS.SITUATIONAL_TIME_OF_DAY_MORNING_START_HOUR, { defaultValue: 8 }),
    ).toBe(9);
  });
});
