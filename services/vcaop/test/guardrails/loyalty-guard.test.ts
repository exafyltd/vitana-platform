import { assertLoyaltyLinkValid, assertLoyaltyEndpointAllowed } from '../../src/guardrails/loyalty-guard';
import { LoyaltyGuardViolation, AccountMarketViolation } from '../../src/guardrails/errors';

describe('loyalty-guard (Sec. 0.3 item 4/5, Sec. 4.6)', () => {
  test('valid read-only credential-free link', () => {
    expect(() =>
      assertLoyaltyLinkValid({
        program: 'AA',
        member_id: 'AA123',
        consent_ref: 'consent://1',
        official_api_token_ref: 'sm://aa/token',
        read_only: true,
      }),
    ).not.toThrow();
  });

  test('rejects non-read-only link', () => {
    expect(() => assertLoyaltyLinkValid({ program: 'AA', read_only: false })).toThrow(/read_only/i);
  });

  test('rejects credential-bearing link', () => {
    expect(() =>
      assertLoyaltyLinkValid({ program: 'AA', read_only: true, password: 'x' } as any),
    ).toThrow(LoyaltyGuardViolation);
    expect(() =>
      assertLoyaltyLinkValid({ program: 'AA', read_only: true, session_cookie: 'c' } as any),
    ).toThrow(LoyaltyGuardViolation);
  });

  test('endpoint guard blocks pool/transfer/resale of loyalty value', () => {
    expect(() => assertLoyaltyEndpointAllowed('/loyalty/link')).not.toThrow();
    // points_transfer trips the account-market guard first (also a hard block) — Sec. 10.
    expect(() => assertLoyaltyEndpointAllowed('/loyalty/points/transfer')).toThrow(AccountMarketViolation);
    expect(() => assertLoyaltyEndpointAllowed('/miles/pool')).toThrow(AccountMarketViolation);
    // loyalty-only verbs (no account-market fragment) trip the loyalty-specific guard.
    expect(() => assertLoyaltyEndpointAllowed('/loyalty/withdraw')).toThrow(LoyaltyGuardViolation);
    expect(() => assertLoyaltyEndpointAllowed('/loyalty/cash-out')).toThrow(LoyaltyGuardViolation);
  });
});
