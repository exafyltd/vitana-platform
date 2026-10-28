/**
 * Subscriptions & Billing (A4) + Vouchers & Referrals (A5) voice tools
 * (Wave 4, plan section A4/A5) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  SUBSCRIPTIONS_BILLING_TOOL_HANDLERS,
  SUBSCRIPTIONS_BILLING_TOOL_DECLARATIONS,
  get_my_subscription,
  compare_subscription_plans,
  upgrade_subscription,
  cancel_subscription,
  add_voice_minutes,
  get_referral_link,
  invite_friend,
} from '../../src/services/orb-tools/subscriptions-billing-tools';

const USER: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community', user_jwt: 'jwt-abc' };
const USER_NO_JWT: OrbToolIdentity = { user_id: 'u-1', tenant_id: 't-1', role: 'community' };
const ANON: OrbToolIdentity = { user_id: '', tenant_id: null, role: null };

function makeSb(overrides: Record<string, unknown> = {}): SupabaseClient {
  const chain: any = {
    select: jest.fn(() => chain),
    ...overrides,
  };
  return { from: jest.fn(() => chain) } as unknown as SupabaseClient;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('catalogue', () => {
  it('exposes all 10 tools with matching declarations', () => {
    const names = Object.keys(SUBSCRIPTIONS_BILLING_TOOL_HANDLERS);
    expect(names).toHaveLength(10);
    const declNames = SUBSCRIPTIONS_BILLING_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });
});

describe('get_my_subscription', () => {
  it('requires an authenticated user', async () => {
    const r = await get_my_subscription({}, ANON, makeSb());
    expect(r.ok).toBe(false);
  });

  it('needs a session JWT', async () => {
    const r = await get_my_subscription({}, USER_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_session');
  });

  it('reports the plan', async () => {
    mockFetch(200, { ok: true, plan: { plan_key: 'pro', status: 'active' } });
    const r = await get_my_subscription({}, USER, makeSb());
    expect(r.text).toContain('pro');
  });
});

describe('compare_subscription_plans', () => {
  it('reads plans + prices directly from Supabase', async () => {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
    };
    const sb = {
      from: jest.fn((table: string) => {
        if (table === 'subscription_plans') {
          return { select: jest.fn().mockResolvedValue({ data: [{ plan_key: 'pro', display_name: 'Pro' }], error: null }) };
        }
        return { select: jest.fn().mockResolvedValue({ data: [{ plan_key: 'pro', price_key: 'pro_m', billing_interval: 'month', price_cents: 999, currency: 'EUR' }], error: null }) };
      }),
    } as unknown as SupabaseClient;
    const r = await compare_subscription_plans({}, USER, sb);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Pro');
  });
});

describe('upgrade_subscription', () => {
  it('requires price_key', async () => {
    const r = await upgrade_subscription({}, USER, makeSb());
    expect(r.ok).toBe(false);
  });

  it('asks for confirmation first', async () => {
    const r = await upgrade_subscription({ price_key: 'pro_m' }, USER, makeSb());
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('starts checkout and returns an open_url directive on confirm', async () => {
    mockFetch(200, { ok: true, session_url: 'https://checkout.stripe.com/xyz' });
    const r = await upgrade_subscription({ price_key: 'pro_m', confirm: true }, USER, makeSb());
    expect(r.ok).toBe(true);
    const result = r.result as { directive: { directive: string; url: string } };
    expect(result.directive.directive).toBe('open_url');
    expect(result.directive.url).toBe('https://checkout.stripe.com/xyz');
  });
});

describe('cancel_subscription', () => {
  it('opens the billing portal', async () => {
    mockFetch(200, { ok: true, url: 'https://billing.stripe.com/portal' });
    const r = await cancel_subscription({}, USER, makeSb());
    expect((r.result as { portal_url: string }).portal_url).toBe('https://billing.stripe.com/portal');
  });
});

describe('add_voice_minutes', () => {
  it('rejects an invalid credit pack', async () => {
    const r = await add_voice_minutes({ credit_pack: 'mega' }, USER, makeSb());
    expect(r.ok).toBe(false);
  });

  it('starts checkout for a valid pack after confirm', async () => {
    mockFetch(200, { ok: true, session_url: 'https://checkout.stripe.com/pack' });
    const r = await add_voice_minutes({ credit_pack: 'boost', confirm: true }, USER, makeSb());
    expect(r.ok).toBe(true);
  });
});

describe('get_referral_link', () => {
  it('returns an existing link if present', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ links: [{ url: 'https://vitana.land/r/abc' }] }) });
    global.fetch = fn as unknown as typeof fetch;
    const r = await get_referral_link({}, USER, makeSb());
    expect(r.text).toContain('https://vitana.land/r/abc');
  });
});

describe('invite_friend', () => {
  it('requires confirmation before generating a link', async () => {
    const r = await invite_friend({}, USER, makeSb());
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});
