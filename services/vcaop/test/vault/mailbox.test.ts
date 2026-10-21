import {
  aliasFor,
  assertSystemAlias,
  extractOtp,
  extractVerificationLink,
  resolveVerificationStep,
  InMemoryMailbox,
  SYSTEM_MAIL_DOMAIN,
} from '../../src/vault/mailbox';

describe('VAULT-OTP-0002 — alias mailbox + OTP polling', () => {
  test('aliasFor is deterministic, on the system domain, with the provider slug', () => {
    const a1 = aliasFor('Amazon SP-API', 'onb_123');
    const a2 = aliasFor('Amazon SP-API', 'onb_123');
    expect(a1).toBe(a2);
    expect(a1).toBe(`provider+amazon-sp-api-onb-123@${SYSTEM_MAIL_DOMAIN}`);
  });

  test('assertSystemAlias rejects personal/non-system inboxes', () => {
    expect(() => assertSystemAlias(aliasFor('ebay', 'o1'))).not.toThrow();
    expect(() => assertSystemAlias('someone@gmail.com')).toThrow(/system alias only/);
    expect(() => assertSystemAlias('provider+x@evil.com')).toThrow();
  });

  test('extractOtp prefers keyword-anchored codes', () => {
    expect(extractOtp('Your verification code is 481920. Ref 2024')).toBe('481920');
    expect(extractOtp('no code here')).toBeNull();
  });

  test('extractVerificationLink finds an https link', () => {
    expect(extractVerificationLink('Click https://verify.example.com/abc?t=1 to confirm')).toBe(
      'https://verify.example.com/abc?t=1',
    );
    expect(extractVerificationLink('no link')).toBeNull();
  });

  test('a simulated verification LINK resolves a job step (AC)', async () => {
    const mb = new InMemoryMailbox();
    const alias = aliasFor('shopify', 'onb_777');
    mb.deliver(alias, { from: 'noreply@shopify.com', subject: 'Confirm', body: 'Confirm here: https://shopify.com/verify/xyz' });
    const result = await resolveVerificationStep(mb, alias);
    expect(result.resolved).toBe(true);
    expect(result.link).toBe('https://shopify.com/verify/xyz');
  });

  test('a simulated OTP resolves a job step', async () => {
    const mb = new InMemoryMailbox();
    const alias = aliasFor('walmart', 'onb_9');
    mb.deliver(alias, { from: 'noreply@walmart.com', subject: 'Code', body: 'Your code: 113355' });
    const result = await resolveVerificationStep(mb, alias);
    expect(result.resolved).toBe(true);
    expect(result.otp).toBe('113355');
  });

  test('empty inbox does not resolve; inboxes are isolated per alias', async () => {
    const mb = new InMemoryMailbox();
    const a = aliasFor('a', 'o1');
    const b = aliasFor('b', 'o2');
    mb.deliver(a, { from: 'x', subject: 's', body: 'code 999000' });
    expect((await resolveVerificationStep(mb, b)).resolved).toBe(false); // b's inbox is empty
    expect((await resolveVerificationStep(mb, a)).resolved).toBe(true);
  });
});
