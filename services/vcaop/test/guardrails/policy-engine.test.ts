import { PolicyEngine, ProviderPolicy } from '../../src/guardrails/policy-engine';
import { PolicyDenied } from '../../src/guardrails/errors';

const apiPolicy: ProviderPolicy = {
  automation_allowed: 'api_only',
  registration_method: 'api',
  captcha_policy: 'human_only',
  kyb_required: false,
  multi_account_allowed: false,
  affiliate_cashback_allowed: true,
  notes: 'test',
};

describe('PolicyEngine (Sec. 4.3) — default deny', () => {
  test('unknown provider is denied', () => {
    const pe = new PolicyEngine();
    expect(() => pe.assertActionAllowed('unknown', 'operate_api')).toThrow(PolicyDenied);
  });

  test('getPolicy falls back to fail-closed DENY_ALL', () => {
    const pe = new PolicyEngine();
    expect(pe.getPolicy('nope').automation_allowed).toBe('denied');
    expect(pe.hasPolicy('nope')).toBe(false);
  });

  test('explicit denied policy blocks every action', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', { ...apiPolicy, automation_allowed: 'denied' });
    expect(() => pe.assertActionAllowed('p', 'operate_api')).toThrow(/denied/i);
  });

  test('api_only allows operate_api but not operate_browser', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', apiPolicy);
    expect(() => pe.assertActionAllowed('p', 'operate_api')).not.toThrow();
    expect(() => pe.assertActionAllowed('p', 'operate_browser')).toThrow(PolicyDenied);
  });

  test('unknown action is denied', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('p', apiPolicy);
    // @ts-expect-error intentionally invalid action
    expect(() => pe.assertActionAllowed('p', 'frobnicate')).toThrow(PolicyDenied);
  });

  test('cashback requires affiliate_cashback_allowed === true', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('no', { ...apiPolicy, affiliate_cashback_allowed: false });
    pe.setPolicy('null', { ...apiPolicy, affiliate_cashback_allowed: null });
    pe.setPolicy('yes', { ...apiPolicy, affiliate_cashback_allowed: true });
    expect(() => pe.assertActionAllowed('no', 'cashback')).toThrow(PolicyDenied);
    expect(() => pe.assertActionAllowed('null', 'cashback')).toThrow(PolicyDenied);
    expect(() => pe.assertActionAllowed('yes', 'cashback')).not.toThrow();
  });

  test('browser_with_human_submit permits operate_browser', () => {
    const pe = new PolicyEngine();
    pe.setPolicy('b', { ...apiPolicy, automation_allowed: 'browser_with_human_submit', affiliate_cashback_allowed: null });
    expect(() => pe.assertActionAllowed('b', 'operate_browser')).not.toThrow();
    expect(() => pe.assertActionAllowed('b', 'operate_api')).toThrow(PolicyDenied);
  });
});
