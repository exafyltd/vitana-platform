import {
  PROVIDER_POLICY_SEEDS,
  SEEDED_PROVIDER_IDS,
  seedPolicyEngine,
} from '../../src/policy/provider-policy-seeds';
import { PolicyEngine } from '../../src/guardrails/policy-engine';
import { PolicyDenied } from '../../src/guardrails/errors';

describe('CTRL-POLICY-0003 — provider policy seeds (Sec. 4.3)', () => {
  test('seeds at least 20 providers', () => {
    expect(SEEDED_PROVIDER_IDS.length).toBeGreaterThanOrEqual(20);
  });

  test('every seed is conservative: human registration, human-only captcha, single-account', () => {
    for (const [id, p] of Object.entries(PROVIDER_POLICY_SEEDS)) {
      expect(p.registration_method).toBe('human_required');
      expect(p.captcha_policy).toBe('human_only');
      expect(p.multi_account_allowed).toBe(false);
      expect(typeof p.notes).toBe('string');
      expect(p.notes.length).toBeGreaterThan(0);
      expect(p.automation_allowed).not.toBe('denied'); // seeds are real providers, not deny stubs
      // sanity: id is canonical snake_case
      expect(id).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test('unknown provider stays default-deny after seeding', () => {
    const pe = seedPolicyEngine();
    expect(pe.hasPolicy('totally_unknown')).toBe(false);
    expect(() => pe.assertActionAllowed('totally_unknown', 'operate_api')).toThrow(PolicyDenied);
  });

  test('seedPolicyEngine populates a fresh engine', () => {
    const pe = seedPolicyEngine(new PolicyEngine());
    for (const id of SEEDED_PROVIDER_IDS) expect(pe.hasPolicy(id)).toBe(true);
  });

  test('api_only marketplace allows operate_api, denies operate_browser', () => {
    const pe = seedPolicyEngine();
    expect(() => pe.assertActionAllowed('amazon', 'operate_api')).not.toThrow();
    expect(() => pe.assertActionAllowed('amazon', 'operate_browser')).toThrow(PolicyDenied);
  });

  test('oauth_only marketplace allows operate_oauth, denies operate_browser', () => {
    const pe = seedPolicyEngine();
    expect(() => pe.assertActionAllowed('shopify', 'operate_oauth')).not.toThrow();
    expect(() => pe.assertActionAllowed('shopify', 'operate_browser')).toThrow(PolicyDenied);
  });

  test('browser_with_human_submit provider allows operate_browser only', () => {
    const pe = seedPolicyEngine();
    expect(() => pe.assertActionAllowed('aliexpress', 'operate_browser')).not.toThrow();
    expect(() => pe.assertActionAllowed('aliexpress', 'operate_api')).toThrow(PolicyDenied);
  });

  test('manual_only loyalty/target denies api/oauth/browser operation', () => {
    const pe = seedPolicyEngine();
    for (const id of ['target', 'united_mileageplus', 'marriott_bonvoy']) {
      expect(() => pe.assertActionAllowed(id, 'operate_manual')).not.toThrow();
      expect(() => pe.assertActionAllowed(id, 'operate_api')).toThrow(PolicyDenied);
      expect(() => pe.assertActionAllowed(id, 'operate_browser')).toThrow(PolicyDenied);
    }
  });

  test('cashback gated: affiliate networks allow, marketplaces & loyalty deny', () => {
    const pe = seedPolicyEngine();
    // affiliate networks/aggregators: cashback allowed
    for (const id of ['awin', 'cj', 'impact', 'rakuten_advertising', 'skimlinks', 'sovrn', 'wildfire']) {
      expect(() => pe.assertActionAllowed(id, 'cashback')).not.toThrow();
    }
    // marketplace (null) and amazon_associates (false) and loyalty (false): denied
    for (const id of ['amazon', 'amazon_associates', 'united_mileageplus']) {
      expect(() => pe.assertActionAllowed(id, 'cashback')).toThrow(PolicyDenied);
    }
  });

  test('loyalty programs are credential-free read-only by policy (no cashback)', () => {
    for (const id of ['united_mileageplus', 'marriott_bonvoy']) {
      expect(PROVIDER_POLICY_SEEDS[id].affiliate_cashback_allowed).toBe(false);
      expect(PROVIDER_POLICY_SEEDS[id].automation_allowed).toBe('manual_only');
    }
  });
});
