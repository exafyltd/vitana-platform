import {
  assertNoSensitiveFields,
  assertLoyaltyRecordCredentialFree,
} from '../../src/guardrails/no-credential-store';
import { CredentialStoreViolation } from '../../src/guardrails/errors';

describe('no-credential-store (Sec. 0.3 item 7)', () => {
  test('allows reference and hash fields', () => {
    expect(() =>
      assertNoSensitiveFields('provider_account', {
        id: 'a1',
        credential_ref: 'sm://providers/x',
        mfa_seed_ref: 'sm://totp/x',
        password_hash: 'argon2id$...',
      }),
    ).not.toThrow();
  });

  test('rejects raw secret fields', () => {
    expect(() => assertNoSensitiveFields('m', { password: 'hunter2' })).toThrow(CredentialStoreViolation);
    expect(() => assertNoSensitiveFields('m', { api_key: 'sk-123' })).toThrow(CredentialStoreViolation);
    expect(() => assertNoSensitiveFields('m', { refresh_token: 'rt' })).toThrow(CredentialStoreViolation);
    expect(() => assertNoSensitiveFields('m', { totp_seed: 'JBSWY3DP' })).toThrow(CredentialStoreViolation);
  });

  test('detects nested secrets', () => {
    expect(() =>
      assertNoSensitiveFields('m', { meta: { nested: { client_secret: 'shh' } } }),
    ).toThrow(CredentialStoreViolation);
    expect(() =>
      assertNoSensitiveFields('m', { items: [{ ok: 1 }, { password: 'x' }] }),
    ).toThrow(CredentialStoreViolation);
  });

  test('loyalty record must be credential-free and read_only', () => {
    expect(() =>
      assertLoyaltyRecordCredentialFree({ program: 'AA', member_id: '123', read_only: true }),
    ).not.toThrow();
    expect(() =>
      assertLoyaltyRecordCredentialFree({ program: 'AA', password: 'x', read_only: true }),
    ).toThrow(CredentialStoreViolation);
    expect(() =>
      assertLoyaltyRecordCredentialFree({ program: 'AA', read_only: false }),
    ).toThrow(/read_only/i);
  });
});
