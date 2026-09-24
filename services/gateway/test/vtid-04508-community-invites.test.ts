/**
 * VTID-04508 (Community Autopilot CA-7): attributed invites + wallet credit.
 */
process.env.NODE_ENV = 'test';

const mockExcluded = jest.fn(async () => new Set<string>());
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: () => mockExcluded(),
}));

import {
  checkClaimEligibility,
  claimInvite,
  getOrCreateInviteLink,
  INVITE_REWARD_MONTHLY_CAP,
  newInviteCode,
  INVITE_CODE_RE,
} from '../src/services/community-autopilot/invites';

const INVITER = 'aaaa1111-1111-4111-8111-111111111111';
const NEWBIE = 'bbbb2222-2222-4222-8222-222222222222';
const TENANT = 'tttt0000-0000-4000-8000-000000000000';
const NOW = new Date('2026-09-24T12:00:00Z');

/** In-memory Supabase subset: sharing_links, referrals, user_tenants, profiles, rpc. */
function memSb(seed: { links?: any[]; referrals?: any[]; tenants?: any[]; rpcError?: boolean } = {}) {
  const t: Record<string, any[]> = {
    sharing_links: [...(seed.links ?? [])],
    referrals: [...(seed.referrals ?? [])],
    user_tenants: [...(seed.tenants ?? [{ user_id: NEWBIE, tenant_id: TENANT }])],
    profiles: [{ user_id: INVITER, first_name: 'Ana' }],
  };
  const rpc = jest.fn(async () => ({ error: seed.rpcError ? { message: 'boom' } : null }));
  let n = 0;
  const sb: any = {
    t, rpc,
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let op: 'select' | 'update' | 'insert' = 'select';
      let patch: any = null;
      let insertRows: any[] = [];
      const q: any = {
        select: () => q,
        limit: () => q,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return q; },
        gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return q; },
        update: (p: any) => { op = 'update'; patch = p; return q; },
        insert: (row: any) => {
          op = 'insert';
          insertRows = Array.isArray(row) ? row : [row];
          return Object.assign(Promise.resolve(doInsert()), { select: async () => doInsert() });
        },
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      };
      let inserted: any = null;
      function doInsert() {
        if (inserted) return inserted;
        for (const r of insertRows) {
          if (table === 'referrals' && t.referrals.some((x) => x.referred_id && x.referred_id === r.referred_id)) {
            inserted = { data: null, error: { code: '23505', message: 'duplicate key' } };
            return inserted;
          }
          if (table === 'sharing_links' && t.sharing_links.some((x) => x.user_id === r.user_id && x.target_type === r.target_type)) {
            inserted = { data: null, error: { code: '23505', message: 'duplicate key' } };
            return inserted;
          }
          const row = { id: `id-${++n}`, ...r };
          t[table].push(row);
        }
        inserted = { data: insertRows.map((_, i) => ({ id: t[table][t[table].length - insertRows.length + i].id })), error: null };
        return inserted;
      }
      function run() {
        const rows = t[table].filter((r) => filters.every((f) => f(r)));
        if (op === 'update') { rows.forEach((r) => Object.assign(r, patch)); return { data: rows.map((r) => ({ id: r.id })), error: null }; }
        return { data: rows, error: null };
      }
      return q;
    },
  };
  return sb;
}

const newUser = { created_at: '2026-09-23T10:00:00Z', email_confirmed_at: '2026-09-23T10:05:00Z' };
const deps = (u = newUser) => ({ getAuthUser: async () => u, now: () => NOW });
const link = { id: 'link-1', user_id: INVITER, tenant_id: TENANT, target_type: 'member_invite', short_code: 'abcd2345' };

beforeEach(() => {
  delete process.env.COMMUNITY_INVITE_REWARD_ENABLED;
  mockExcluded.mockResolvedValue(new Set());
});

describe('invite links', () => {
  it('codes are unambiguous and match the accepted pattern', () => {
    const c = newInviteCode();
    expect(c).toMatch(INVITE_CODE_RE);
    expect(c).not.toMatch(/[01ilo]/);
  });

  it('one reusable link per member', async () => {
    const sb = memSb();
    const a = await getOrCreateInviteLink(sb, INVITER, TENANT);
    const b = await getOrCreateInviteLink(sb, INVITER, TENANT);
    expect(a?.code).toBe(b?.code);
    expect(a?.url).toBe(`https://vitanaland.com/i/${a?.code}`);
    expect(sb.t.sharing_links).toHaveLength(1);
  });
});

describe('eligibility (anti-abuse)', () => {
  const base = { inviterId: INVITER, claimantId: NEWBIE, excluded: new Set<string>(), inviterTenantId: TENANT, claimantTenantIds: [TENANT], authUser: newUser, now: NOW };
  it('accepts a new, confirmed member of the same community', () => expect(checkClaimEligibility(base)).toBeNull());
  it('refuses self invites', () => expect(checkClaimEligibility({ ...base, claimantId: INVITER })).toBe('self_invite'));
  it('refuses test/service accounts on either side', () => {
    expect(checkClaimEligibility({ ...base, excluded: new Set([INVITER]) })).toBe('test_or_service_account');
    expect(checkClaimEligibility({ ...base, excluded: new Set([NEWBIE]) })).toBe('test_or_service_account');
  });
  it('refuses another community', () => expect(checkClaimEligibility({ ...base, claimantTenantIds: ['other'] })).toBe('different_community'));
  it('refuses old accounts and unconfirmed emails', () => {
    expect(checkClaimEligibility({ ...base, authUser: { created_at: '2026-08-01T00:00:00Z', email_confirmed_at: 'x' } })).toBe('account_not_new');
    expect(checkClaimEligibility({ ...base, authUser: { created_at: newUser.created_at, email_confirmed_at: null } })).toBe('email_not_confirmed');
  });
});

describe('claim', () => {
  it('attributes once; the reward stays off unless the flag is exactly true', async () => {
    const sb = memSb({ links: [link] });
    const first = await claimInvite(sb, NEWBIE, 'abcd2345', deps());
    expect(first).toMatchObject({ status: 'attributed', rewarded: false, reward_reason: 'reward_disabled' });
    expect(sb.rpc).not.toHaveBeenCalled();
    const second = await claimInvite(sb, NEWBIE, 'abcd2345', deps());
    expect(second.status).toBe('already_attributed');
    expect(sb.t.referrals).toHaveLength(1);
  });

  it('with the flag on, credits the inviter exactly once', async () => {
    process.env.COMMUNITY_INVITE_REWARD_ENABLED = 'true';
    const sb = memSb({ links: [link] });
    const r = await claimInvite(sb, NEWBIE, 'abcd2345', deps());
    expect(r).toMatchObject({ status: 'attributed', rewarded: true, credits: 200 });
    expect(sb.rpc).toHaveBeenCalledTimes(1);
    expect(sb.rpc).toHaveBeenCalledWith('increment_wallet_balance', { p_user_id: INVITER, p_currency_type: 'CREDITS', p_amount: 200 });
    expect(sb.t.referrals[0].status).toBe('rewarded');
  });

  it(`stops rewarding after ${INVITE_REWARD_MONTHLY_CAP} in 30 days (attribution still recorded)`, async () => {
    process.env.COMMUNITY_INVITE_REWARD_ENABLED = 'true';
    const prior = Array.from({ length: INVITE_REWARD_MONTHLY_CAP }, (_, i) => ({
      id: `p${i}`, referrer_id: INVITER, referred_id: `x${i}`, status: 'rewarded', rewarded_at: '2026-09-20T00:00:00Z',
    }));
    const sb = memSb({ links: [link], referrals: prior });
    const r = await claimInvite(sb, NEWBIE, 'abcd2345', deps());
    expect(r).toMatchObject({ status: 'attributed', rewarded: false, reward_reason: 'monthly_cap' });
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it('a failed credit rolls the referral back to signed_up', async () => {
    process.env.COMMUNITY_INVITE_REWARD_ENABLED = 'true';
    const sb = memSb({ links: [link], rpcError: true });
    const r = await claimInvite(sb, NEWBIE, 'abcd2345', deps());
    expect(r).toMatchObject({ rewarded: false, reward_reason: 'credit_failed' });
    expect(sb.t.referrals[0].status).toBe('signed_up');
  });

  it('unknown codes and rejected claimants write nothing', async () => {
    const sb = memSb({ links: [link] });
    expect(await claimInvite(sb, NEWBIE, 'zzzz9999', deps())).toEqual({ status: 'invalid_code' });
    expect(await claimInvite(sb, NEWBIE, 'abcd2345', deps({ created_at: '2026-01-01T00:00:00Z', email_confirmed_at: 'x' })))
      .toEqual({ status: 'rejected', reason: 'account_not_new' });
    expect(sb.t.referrals).toHaveLength(0);
  });
});

describe('routes', () => {
  const express = require('express');
  const request = require('supertest');
  let identity: any = null;

  beforeAll(() => {
    jest.resetModules();
  });

  function mount() {
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      optionalAuth: (req: any, _res: any, next: any) => { if (identity) req.identity = identity; next(); },
    }));
    jest.doMock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => undefined) }));
    const router = require('../src/routes/community-invites').default;
    const app = express();
    app.use(express.json());
    app.use('/api/v1/invites', router);
    return app;
  }

  it('my link and a claim need a signed-in member', async () => {
    identity = null;
    const app = mount();
    expect((await request(app).get('/api/v1/invites/me')).status).toBe(401);
    expect((await request(app).post('/api/v1/invites/claim').send({ code: 'abcd2345' })).status).toBe(401);
  });

  it('a claim without a code is a 400', async () => {
    identity = { user_id: NEWBIE };
    const app = mount();
    expect((await request(app).post('/api/v1/invites/claim').send({})).status).toBe(400);
  });
});
