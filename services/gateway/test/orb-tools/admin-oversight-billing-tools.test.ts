/**
 * Admin Community Oversight (B5) + Billing & Wallet Admin (B7) voice tools
 * (Wave 4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_OVERSIGHT_BILLING_TOOL_HANDLERS,
  ADMIN_OVERSIGHT_BILLING_TOOL_DECLARATIONS,
  admin_list_meetups,
  admin_delete_meetup,
  admin_community_stats,
  admin_credit_wallet,
  admin_debit_wallet,
  admin_get_founding_status,
  admin_run_monetization_detect,
} from '../../src/services/orb-tools/admin-oversight-billing-tools';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'jwt-abc' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };

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

function makeSb(overrides: Record<string, unknown>): SupabaseClient {
  const chain: any = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn(), ...overrides };
  return { from: jest.fn(() => chain) } as unknown as SupabaseClient;
}

describe('catalogue', () => {
  const names = Object.keys(ADMIN_OVERSIGHT_BILLING_TOOL_HANDLERS);

  it('exposes all 13 tools with matching declarations', () => {
    expect(names).toHaveLength(13);
    const declNames = ADMIN_OVERSIGHT_BILLING_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await ADMIN_OVERSIGHT_BILLING_TOOL_HANDLERS[name](
      { meetup_id: 'm1', user_id: 'u-1', currency: 'EUR', amount_minor: 100, message: 'hi' },
      COMMUNITY_ID,
      makeSb({}),
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_OVERSIGHT_BILLING_TOOL_HANDLERS[name]({}, ANON_ID, makeSb({}));
    expect(r.ok).toBe(false);
  });
});

describe('admin_list_meetups / admin_delete_meetup', () => {
  it('lists meetups', async () => {
    mockFetch(200, { meetups: [{ title: 'Yoga Day' }] });
    const r = await admin_list_meetups({}, ADMIN_ID, makeSb({}));
    expect(r.text).toContain('1 meetups');
  });

  it('delete_meetup requires confirmation first', async () => {
    const r = await admin_delete_meetup({ meetup_id: 'm1' }, ADMIN_ID, makeSb({}));
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('admin_community_stats', () => {
  it('reports counts', async () => {
    mockFetch(200, { stats: { meetups: 3, groups: 2, live_rooms: 1, memberships: 40 } });
    const r = await admin_community_stats({}, ADMIN_ID, makeSb({}));
    expect(r.text).toContain('3 meetups');
  });
});

describe('admin_credit_wallet / admin_debit_wallet (exafy_admin only)', () => {
  it('rejects a plain admin session', async () => {
    const r = await admin_credit_wallet({ user_id: 'u-1', currency: 'EUR', amount_minor: 500 }, ADMIN_ID, makeSb({}));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('exafy_admin');
  });

  it('reports honestly when the target has no wallet account', async () => {
    const sb = makeSb({ maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) });
    const r = await admin_credit_wallet({ user_id: 'u-1', currency: 'EUR', amount_minor: 500 }, EXAFY_ID, sb);
    expect((r.result as { reason: string }).reason).toBe('no_wallet_account');
  });

  it('requires confirmation before crediting', async () => {
    const sb = makeSb({ maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'acct-1' }, error: null }) });
    const r = await admin_credit_wallet({ user_id: 'u-1', currency: 'EUR', amount_minor: 500 }, EXAFY_ID, sb);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('credits the resolved account on confirm', async () => {
    const sb = makeSb({ maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'acct-1' }, error: null }) });
    mockFetch(200, { ok: true });
    const r = await admin_credit_wallet({ user_id: 'u-1', currency: 'EUR', amount_minor: 500, confirm: true }, EXAFY_ID, sb);
    expect(r.text).toContain('credited');
  });

  it('debits the resolved account on confirm', async () => {
    const sb = makeSb({ maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'acct-1' }, error: null }) });
    mockFetch(200, { ok: true });
    const r = await admin_debit_wallet({ user_id: 'u-1', currency: 'EUR', amount_minor: 500, confirm: true }, EXAFY_ID, sb);
    expect(r.text).toContain('debited');
  });
});

describe('admin_get_founding_status', () => {
  it('reports no active campaign honestly', async () => {
    mockFetch(200, { active: false });
    const r = await admin_get_founding_status({}, ADMIN_ID, makeSb({}));
    expect(r.text).toBe('No active Founding campaign.');
  });
});

describe('admin_run_monetization_detect', () => {
  it('requires a message', async () => {
    const r = await admin_run_monetization_detect({}, ADMIN_ID, makeSb({}));
    expect(r.ok).toBe(false);
  });

  it('reports detected signals', async () => {
    mockFetch(200, { total_count: 2 });
    const r = await admin_run_monetization_detect({ message: 'I want to buy this now' }, ADMIN_ID, makeSb({}));
    expect(r.text).toContain('2 signals');
  });
});
