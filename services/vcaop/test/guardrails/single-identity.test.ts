import { assertSingleActiveAccount, isActiveStatus, ExistingAccount } from '../../src/guardrails/single-identity';
import { SingleIdentityViolation } from '../../src/guardrails/errors';

const acc = (status: string): ExistingAccount => ({ tenant_id: 't1', provider_id: 'amazon', status });

describe('single-identity (Sec. 0.3 item 5/6)', () => {
  test('status classification', () => {
    expect(isActiveStatus('active')).toBe(true);
    expect(isActiveStatus('kyb_pending')).toBe(true);
    expect(isActiveStatus('retired')).toBe(false);
    expect(isActiveStatus('failed')).toBe(false);
    expect(isActiveStatus('weird_unknown')).toBe(true); // fail-closed
  });

  test('first active account allowed', () => {
    expect(() => assertSingleActiveAccount('t1', 'amazon', [], false)).not.toThrow();
    expect(() => assertSingleActiveAccount('t1', 'amazon', [acc('retired')], false)).not.toThrow();
  });

  test('second active account blocked when multi disallowed', () => {
    expect(() => assertSingleActiveAccount('t1', 'amazon', [acc('active')], false)).toThrow(
      SingleIdentityViolation,
    );
  });

  test('multi_account_allowed bypasses the cap', () => {
    expect(() => assertSingleActiveAccount('t1', 'amazon', [acc('active')], true)).not.toThrow();
  });

  test('counts only the matching tenant+provider', () => {
    const others: ExistingAccount[] = [
      { tenant_id: 't2', provider_id: 'amazon', status: 'active' },
      { tenant_id: 't1', provider_id: 'ebay', status: 'active' },
    ];
    expect(() => assertSingleActiveAccount('t1', 'amazon', others, false)).not.toThrow();
  });
});
