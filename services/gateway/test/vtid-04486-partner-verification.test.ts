/**
 * VTID-04486 — partner verification rules (spec §7): levels, VAT
 * normalisation, domain ownership, the VIES client's verdicts, and the
 * checklist voiding a result once the facts it checked change.
 */

import {
  computeVerification,
  domainProofInstructions,
  domainsMatch,
  emailDomainOf,
  hostOf,
  htmlContainsMetaToken,
  normalizeVatNumber,
  txtRecordsContainToken,
  type VerificationChecks,
} from '../src/services/partner-verification';
import { buildChecklist } from '../src/services/partner-onboarding-checklist';
import { checkVatVies } from '../src/services/partner-verification-io';

const ALL_PASSED: VerificationChecks = {
  email_verified: 'passed',
  domain: 'passed',
  vat: 'passed',
  business_verification: 'passed',
  licence: 'passed',
};

describe('computeVerification', () => {
  it('level 0 is done with a confirmed email and a proven domain, and credits nothing unchecked', () => {
    const r = computeVerification(0, {
      ...ALL_PASSED,
      vat: 'pending',
      business_verification: 'not_configured',
      licence: 'not_configured',
    });
    expect(r).toEqual({ level_reached: 0, step_status: 'done', missing: [] });
  });

  it('a VAT id not required outside the EU does not block level 1', () => {
    const r = computeVerification(1, { ...ALL_PASSED, vat: 'not_required', licence: 'not_configured' });
    expect(r).toEqual({ level_reached: 1, step_status: 'done', missing: [] });
  });

  it('stays in progress while ownership is unproven', () => {
    const r = computeVerification(0, { ...ALL_PASSED, domain: 'pending' });
    expect(r.level_reached).toBeNull();
    expect(r.step_status).toBe('in_progress');
    expect(r.missing).toEqual(['domain_proof']);
  });

  it('a type that needs level 1 cannot finish while business verification has no provider', () => {
    const r = computeVerification(1, { ...ALL_PASSED, business_verification: 'not_configured', licence: 'not_configured' });
    expect(r.level_reached).toBe(0);
    expect(r.step_status).toBe('in_progress');
    expect(r.missing).toEqual(['business_verification_not_configured']);
  });

  it('an invalid VAT id fails the step', () => {
    const r = computeVerification(1, { ...ALL_PASSED, vat: 'failed' });
    expect(r.step_status).toBe('failed');
    expect(r.missing).toContain('vat_invalid');
  });

  it('a VIES outage is retryable, not a failure', () => {
    const r = computeVerification(1, { ...ALL_PASSED, vat: 'unavailable' });
    expect(r.step_status).toBe('in_progress');
    expect(r.missing).toEqual(['vat_check_unavailable']);
  });

  it('level 2 needs the licence check too', () => {
    const r = computeVerification(2, { ...ALL_PASSED, licence: 'not_configured' });
    expect(r.level_reached).toBe(1);
    expect(r.missing).toEqual(['licence_verification_not_configured']);
  });

  it('ignores checks above the required level when naming what is missing', () => {
    const r = computeVerification(0, { ...ALL_PASSED, vat: 'failed' });
    expect(r.step_status).toBe('done');
    expect(r.missing).toEqual([]);
  });
});

describe('normalizeVatNumber', () => {
  it('strips the prefix and separators', () => {
    expect(normalizeVatNumber('DE 123.456-789', 'DE')).toEqual({ country_code: 'DE', number: '123456789' });
    expect(normalizeVatNumber('123456789', 'DE')).toEqual({ country_code: 'DE', number: '123456789' });
  });
  it('uses EL for Greece and accepts either prefix', () => {
    expect(normalizeVatNumber('GR123456789', 'GR')).toEqual({ country_code: 'EL', number: '123456789' });
    expect(normalizeVatNumber('EL123456789', 'GR')).toEqual({ country_code: 'EL', number: '123456789' });
  });
  it('refuses what cannot be a VAT number', () => {
    expect(normalizeVatNumber('DE', 'DE')).toBeNull();
    expect(normalizeVatNumber('DE12345678901234', 'DE')).toBeNull();
  });
});

describe('domain ownership', () => {
  it('reads hosts and email domains', () => {
    expect(hostOf('https://www.Acme.example/shop')).toBe('acme.example');
    expect(hostOf('not a url')).toBeNull();
    expect(emailDomainOf('Ann@Acme.Example')).toBe('acme.example');
    expect(emailDomainOf('nobody')).toBeNull();
  });

  it('matches a domain and its subdomains, never a mailbox provider', () => {
    expect(domainsMatch('acme.example', 'acme.example')).toBe(true);
    expect(domainsMatch('shop.acme.example', 'acme.example')).toBe(true);
    expect(domainsMatch('acme.example', 'mail.acme.example')).toBe(true);
    expect(domainsMatch('notacme.example', 'acme.example')).toBe(false);
    expect(domainsMatch('gmail.com', 'gmail.com')).toBe(false);
  });

  it('finds the token in a TXT record, split or whole', () => {
    expect(txtRecordsContainToken([['vitana-verification=', 'abc']], 'abc')).toBe(true);
    expect(txtRecordsContainToken([['vitana-verification=abcd']], 'abc')).toBe(false);
  });

  it('finds the token in a meta tag in either attribute order', () => {
    expect(htmlContainsMetaToken('<meta name="vitana-site-verification" content="abc">', 'abc')).toBe(true);
    expect(htmlContainsMetaToken("<meta content='abc' name='Vitana-Site-Verification' />", 'abc')).toBe(true);
    expect(htmlContainsMetaToken('<meta name="description" content="abc">', 'abc')).toBe(false);
  });

  it('tells the partner exactly what to publish', () => {
    expect(domainProofInstructions('acme.example', 'abc')).toEqual({
      token: 'abc',
      dns_txt_name: '_vitana-verification.acme.example',
      dns_txt_value: 'vitana-verification=abc',
      meta_tag: '<meta name="vitana-site-verification" content="abc">',
    });
  });
});

describe('checkVatVies', () => {
  const reply = (status: number, body: unknown) =>
    (jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body }) as unknown) as typeof fetch;

  it('valid, with the registered name', async () => {
    const f = reply(200, { isValid: true, userError: 'VALID', name: 'ACME GMBH' });
    expect(await checkVatVies('DE', '123456789', f)).toEqual({ status: 'valid', name: 'ACME GMBH' });
    expect((f as any).mock.calls[0][0]).toBe('https://ec.europa.eu/taxation_customs/vies/rest-api/ms/DE/vat/123456789');
  });

  it('a withheld name is null', async () => {
    expect(await checkVatVies('DE', '1', reply(200, { isValid: true, name: '---' }))).toEqual({ status: 'valid', name: null });
  });

  it('invalid only when VIES says the number is wrong', async () => {
    expect((await checkVatVies('DE', '1', reply(200, { isValid: false, userError: 'INVALID' }))).status).toBe('invalid');
    expect((await checkVatVies('DE', '1', reply(200, { isValid: false, userError: 'MS_UNAVAILABLE' }))).status).toBe('unavailable');
    expect((await checkVatVies('DE', '1', reply(503, {}))).status).toBe('unavailable');
  });

  it('a network error is unavailable, never a throw', async () => {
    const f = (jest.fn().mockRejectedValue(new Error('boom')) as unknown) as typeof fetch;
    expect(await checkVatVies('DE', '1', f)).toEqual({ status: 'unavailable', name: null, error: 'boom' });
  });
});

describe('checklist: a verification result is void once its facts change', () => {
  const org = { partner_type: 'supplier_shop' as const, legal_name: 'Acme', country: 'DE', vat_id: 'DE1', website: 'https://acme.example/' };
  const row = (facts: Record<string, unknown>) => ({
    step_key: 'verification',
    status: 'done',
    detail: { facts },
  });
  const base = { acceptedTermsVersions: [], currentTermsVersion: null, memberCount: 1 };
  const verificationStep = (steps: any[]) => buildChecklist({ org, storedSteps: steps, ...base }).steps.find((s) => s.key === 'verification');

  it('holds while the facts are unchanged', () => {
    expect(verificationStep([row({ website: org.website, country: 'DE', vat_id: 'DE1' })])?.status).toBe('done');
  });

  it('is todo with facts_changed after the website changes', () => {
    const s = verificationStep([row({ website: 'https://old.example/', country: 'DE', vat_id: 'DE1' })]);
    expect(s?.status).toBe('todo');
    expect(s?.missing).toEqual(['facts_changed']);
  });
});
