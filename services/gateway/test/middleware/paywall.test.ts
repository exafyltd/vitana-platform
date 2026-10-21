/**
 * Tests for src/middleware/paywall.ts (VTID-03107 · Billing v1 paywall gate).
 *
 * Contract under test:
 *   - 401 UNAUTHENTICATED when req.identity or tenant_id is missing (defense
 *     in depth; auth middleware normally enforces this).
 *   - allow / soft_counter / degrade / deferred → next() with req.entitlement.
 *   - paywall → 402 payment_required with structured paywall body; credit_option
 *     present only when credits can be spent.
 *   - hard_block → 402 with credit_option null even when credits exist.
 *   - checkEntitlement crash → FAIL OPEN: next() with a degraded 'allow'
 *     entitlement marker (never block on infrastructure failure).
 *   - Options plumbing: amount, skipD36, sessionIdGetter precedence, and the
 *     bearer token forwarded to checkEntitlement for D36.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../../src/services/entitlement-service', () => ({
  checkEntitlement: jest.fn(),
}));

import { requireEntitlement } from '../../src/middleware/paywall';
import { checkEntitlement, type CheckResult } from '../../src/services/entitlement-service';

const mockCheckEntitlement = checkEntitlement as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    allowed: true,
    paywall_action: 'allow',
    feature: 'match_posts',
    tier: 'free',
    quota: 15,
    used: 3,
    remaining: 12,
    reset_at: '2026-08-01T00:00:00Z',
    windows: [],
    binding_window: 'monthly',
    credit_cost_per_unit: 5,
    user_credit_balance: 250,
    allowed_burn_buckets: ['purchased_credits'],
    deferred_for_vulnerability: false,
    ...overrides,
  };
}

// Mutable identity injected by a stub auth middleware ahead of the gate
let currentIdentity: any;

const app = express();
app.use((req: any, _res, next) => {
  req.identity = currentIdentity;
  next();
});
app.post('/gated', requireEntitlement('match_posts'), (req: any, res) =>
  res.json({ ok: true, entitlement: req.entitlement })
);
app.post(
  '/gated-opts',
  requireEntitlement('voice_live_minutes', {
    amount: 5,
    skipD36: true,
    sessionIdGetter: () => 'sess-from-getter',
  }),
  (req: any, res) => res.json({ ok: true, entitlement: req.entitlement })
);

describe('requireEntitlement (paywall middleware)', () => {
  beforeEach(() => {
    currentIdentity = { user_id: 'user-1', tenant_id: 'tenant-1' };
    mockCheckEntitlement.mockResolvedValue(makeResult());
  });

  // --- Auth defense in depth -------------------------------------------------

  it('returns 401 UNAUTHENTICATED when no identity is attached', async () => {
    currentIdentity = undefined;

    const res = await request(app).post('/gated');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: 'UNAUTHENTICATED',
      feature: 'match_posts',
      vtid: 'VTID-03107',
    });
    expect(mockCheckEntitlement).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when the identity has no tenant_id', async () => {
    currentIdentity = { user_id: 'user-1', tenant_id: null };

    const res = await request(app).post('/gated');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockCheckEntitlement).not.toHaveBeenCalled();
  });

  // --- Pass-through actions ---------------------------------------------------

  it('calls the handler and attaches req.entitlement on allow', async () => {
    const result = makeResult({ paywall_action: 'allow' });
    mockCheckEntitlement.mockResolvedValue(result);

    const res = await request(app)
      .post('/gated')
      .set('Authorization', 'Bearer user-jwt')
      .set('x-session-id', 'sess-header');

    expect(res.status).toBe(200);
    expect(res.body.entitlement).toEqual(result);
    expect(mockCheckEntitlement).toHaveBeenCalledWith('user-1', 'tenant-1', 'match_posts', {
      amount: undefined,
      sessionId: 'sess-header',
      authToken: 'user-jwt',
      skipD36: undefined,
    });
  });

  it.each(['soft_counter', 'degrade', 'deferred'] as const)(
    'lets the handler run on paywall_action=%s',
    async (action) => {
      mockCheckEntitlement.mockResolvedValue(makeResult({ paywall_action: action, allowed: false }));

      const res = await request(app).post('/gated');
      expect(res.status).toBe(200);
      expect(res.body.entitlement.paywall_action).toBe(action);
    }
  );

  it('passes authToken=undefined when there is no Authorization header', async () => {
    await request(app).post('/gated');
    expect(mockCheckEntitlement).toHaveBeenCalledWith(
      'user-1',
      'tenant-1',
      'match_posts',
      expect.objectContaining({ authToken: undefined })
    );
  });

  // --- 402 paywall path -------------------------------------------------------

  it('returns 402 payment_required with a structured paywall body on paywall', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeResult({
        allowed: false,
        paywall_action: 'paywall',
        quota: 15,
        used: 15,
        remaining: 0,
        credit_cost_per_unit: 5,
        user_credit_balance: 250,
      })
    );

    const res = await request(app).post('/gated');

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      ok: false,
      error: 'payment_required',
      paywall: {
        feature: 'match_posts',
        tier: 'free',
        quota: 15,
        used: 15,
        remaining: 0,
        reset_at: '2026-08-01T00:00:00Z',
        credit_cost_per_unit: 5,
        user_credit_balance: 250,
        allowed_burn_buckets: ['purchased_credits'],
        credit_option: {
          cost_per_unit: 5,
          balance: 250,
          balance_sufficient_for_one_unit: true,
          endpoint: '/api/v1/billing/credits/spend',
        },
        upgrade_url: '/api/v1/billing/checkout/subscription',
        deferred_for_vulnerability: false,
        paywall_action: 'paywall',
      },
      vtid: 'VTID-03107',
    });
  });

  it('flags an insufficient credit balance in credit_option', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeResult({
        paywall_action: 'paywall',
        credit_cost_per_unit: 100,
        user_credit_balance: 40,
      })
    );

    const res = await request(app).post('/gated');
    expect(res.status).toBe(402);
    expect(res.body.paywall.credit_option.balance_sufficient_for_one_unit).toBe(false);
  });

  it('omits credit_option when the feature has no credit price', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeResult({ paywall_action: 'paywall', credit_cost_per_unit: 0 })
    );

    const res = await request(app).post('/gated');
    expect(res.status).toBe(402);
    expect(res.body.paywall.credit_option).toBeNull();
  });

  it('omits credit_option when no burn buckets are allowed', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeResult({ paywall_action: 'paywall', allowed_burn_buckets: [] })
    );

    const res = await request(app).post('/gated');
    expect(res.status).toBe(402);
    expect(res.body.paywall.credit_option).toBeNull();
  });

  it('returns 402 with credit_option null on hard_block even when credits exist', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeResult({
        paywall_action: 'hard_block',
        credit_cost_per_unit: 5,
        user_credit_balance: 1000,
      })
    );

    const res = await request(app).post('/gated');
    expect(res.status).toBe(402);
    expect(res.body.paywall.credit_option).toBeNull();
    expect(res.body.paywall.paywall_action).toBe('hard_block');
  });

  // --- Fail-open on infrastructure failure ------------------------------------

  it('fails OPEN with a degraded allow entitlement when checkEntitlement crashes', async () => {
    mockCheckEntitlement.mockRejectedValue(new Error('supabase timeout'));

    const res = await request(app).post('/gated');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entitlement).toMatchObject({
      allowed: true,
      paywall_action: 'allow',
      feature: 'match_posts',
      tier: 'unknown',
      quota: -1,
      remaining: -1,
    });
  });

  // --- Options plumbing ---------------------------------------------------------

  it('forwards amount/skipD36 and prefers sessionIdGetter over the header', async () => {
    mockCheckEntitlement.mockResolvedValue(makeResult({ feature: 'voice_live_minutes' }));

    const res = await request(app)
      .post('/gated-opts')
      .set('Authorization', 'Bearer user-jwt')
      .set('x-session-id', 'sess-header');

    expect(res.status).toBe(200);
    expect(mockCheckEntitlement).toHaveBeenCalledWith('user-1', 'tenant-1', 'voice_live_minutes', {
      amount: 5,
      sessionId: 'sess-from-getter',
      authToken: 'user-jwt',
      skipD36: true,
    });
  });
});
