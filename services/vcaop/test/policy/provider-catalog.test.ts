import { PROVIDER_CATALOG, CATALOG_IDS, policyFor, providerRowFor } from '../../src/policy/provider-catalog';

describe('Provider catalog (batch-onboarding prepared list)', () => {
  test('is broad and well-formed', () => {
    expect(PROVIDER_CATALOG.length).toBeGreaterThanOrEqual(70);
    expect(new Set(CATALOG_IDS).size).toBe(CATALOG_IDS.length); // unique ids
    for (const e of PROVIDER_CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9_]+$/);
      expect(['marketplace', 'affiliate', 'travel', 'delivery', 'loyalty']).toContain(e.category);
      expect(['api', 'oauth', 'scim', 'browser', 'manual']).toContain(e.connectorMode);
    }
  });

  test('every derived policy is conservative', () => {
    for (const e of PROVIDER_CATALOG) {
      const p = policyFor(e);
      expect(p.registration_method).toBe('human_required');
      expect(p.captcha_policy).toBe('human_only');
      expect(p.multi_account_allowed).toBe(false);
    }
  });

  test('cashback gating by category', () => {
    for (const e of PROVIDER_CATALOG) {
      const cb = policyFor(e).affiliate_cashback_allowed;
      if (e.category === 'loyalty') expect(cb).toBe(false);
      else if (e.category === 'affiliate' && e.cashback === undefined) expect(cb).toBe(true);
      else if (e.category === 'marketplace' || e.category === 'travel' || e.category === 'delivery') {
        if (e.cashback === undefined) expect(cb).toBeNull();
      }
    }
  });

  test('loyalty providers are manual + no KYB', () => {
    for (const e of PROVIDER_CATALOG.filter((x) => x.category === 'loyalty')) {
      const row = providerRowFor(e);
      expect(row.connector_mode).toBe('manual');
      expect(row.kyb_required).toBe(false);
    }
  });

  test('coverage across categories', () => {
    const byCat = (c: string) => PROVIDER_CATALOG.filter((e) => e.category === c).length;
    expect(byCat('marketplace')).toBeGreaterThanOrEqual(20);
    expect(byCat('affiliate')).toBeGreaterThanOrEqual(15);
    expect(byCat('travel')).toBeGreaterThanOrEqual(10);
    expect(byCat('loyalty')).toBeGreaterThanOrEqual(8);
  });
});
