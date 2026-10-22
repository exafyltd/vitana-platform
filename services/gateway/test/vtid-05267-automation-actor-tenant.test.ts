/**
 * VTID-05267 (mt-jobs, lane jobs-automation-actor-tenant): automation events
 * carry the actor's real tenant.
 *
 * Seven dispatch sites: six direct pins of DEFAULT_TENANT_ID
 * (community.ts /groups/:id/join, /global-groups/:id/view,
 * /global-groups/:id/join; match-feedback.ts /:id/feedback; matchmaking.ts
 * /:id/state; admin-signups.ts /log-result) and the fallback site
 * groups-events-tools.ts join_group (`id.tenant_id || DEFAULT_TENANT_ID`).
 *
 * MT_RESOLUTION_V2 off ⇒ DEFAULT_TENANT_ID exactly as today, no lookup.
 * On ⇒ the actor's tenant via resolveActorTenant (known tenant, else the
 * existing resolvePrimaryTenant — mocked here); not 'found' ⇒ no dispatch,
 * never DEFAULT_TENANT_ID (Maxina).
 */

jest.mock('../src/services/automation-executor', () => ({
  dispatchEvent: jest.fn().mockResolvedValue({ dispatched: [], errors: [] }),
}));
jest.mock('../src/services/tenancy/tenant-context', () => ({
  resolvePrimaryTenant: jest.fn(),
}));
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => ({})),
}));
jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
  notifyUsersAsync: jest.fn(),
}));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const raw = req.headers['x-test-identity'];
    if (!raw) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = JSON.parse(String(raw));
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, res: any) => res.status(403).json({ ok: false }),
}));
jest.mock('../src/routes/community-repository');
jest.mock('../src/routes/match-feedback-repository');
jest.mock('../src/routes/matchmaking-repository');
jest.mock('../src/services/admin-signups/admin-signups-repository');

import express from 'express';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchEvent } from '../src/services/automation-executor';
import { resolvePrimaryTenant } from '../src/services/tenancy/tenant-context';
import * as communityRepo from '../src/routes/community-repository';
import * as feedbackRepo from '../src/routes/match-feedback-repository';
import * as matchRepo from '../src/routes/matchmaking-repository';
import * as signupsRepo from '../src/services/admin-signups/admin-signups-repository';
import communityRouter from '../src/routes/community';
import matchFeedbackRouter from '../src/routes/match-feedback';
import matchmakingRouter from '../src/routes/matchmaking';
import adminSignupsRouter from '../src/routes/admin-signups';
import { tool_join_group } from '../src/services/orb-tools/groups-events-tools';

const MAXINA = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GROUP = '11111111-1111-4111-8111-111111111111';
const MATCH = '22222222-2222-4222-8222-222222222222';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ sub: ACTOR })}.sig`;

const app = express();
app.use(express.json());
app.use('/community', communityRouter);
app.use('/match', matchFeedbackRouter);
app.use('/match', matchmakingRouter);
app.use('/admin-signups', adminSignupsRouter);

const dispatchMock = dispatchEvent as jest.Mock;
const primaryMock = resolvePrimaryTenant as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function setFlag(on: boolean): void {
  if (on) process.env.MT_RESOLUTION_V2 = 'true';
  else delete process.env.MT_RESOLUTION_V2;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DEFAULT_TENANT_ID = MAXINA;
  process.env.SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_ANON_KEY = 'anon';
  delete process.env.SUPABASE_SERVICE_ROLE;
  delete process.env.MT_RESOLUTION_V2;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  (communityRepo.joinCommunityGroupRpc as jest.Mock).mockResolvedValue({
    data: { ok: true, membership_id: 'm-1' },
    error: null,
  });
  (communityRepo.fetchGlobalGroupById as jest.Mock).mockResolvedValue({ data: { id: GROUP }, error: null });
  (communityRepo.fetchGlobalGroupMembership as jest.Mock).mockResolvedValue({ data: null, error: null });
  (communityRepo.insertGlobalGroupMembership as jest.Mock).mockResolvedValue({ error: null });
  (feedbackRepo.recordMatchFeedbackRpc as jest.Mock).mockResolvedValue({
    data: { ok: true, feedback_id: 'f-1', feedback_type: 'like', match_id: MATCH, changes: [] },
    error: null,
  });
  (matchRepo.setMatchStateRpc as jest.Mock).mockResolvedValue({ data: { ok: true, edge_created: false }, error: null });
  (matchRepo.fetchMatchUsersAndTenant as jest.Mock).mockResolvedValue({ data: null });
  (matchRepo.fetchMatchTenantId as jest.Mock).mockResolvedValue({ data: null });
  (signupsRepo.updateSignupAttempt as jest.Mock).mockResolvedValue({ error: null });
  (signupsRepo.fetchAttemptReferralInfo as jest.Mock).mockResolvedValue({ data: null });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

// ── The four raw-bearer member routes: actor = the token `sub` ──────────────

const rawBearerSites: Array<{ name: string; event: string; call: () => request.Test }> = [
  {
    name: 'community.ts POST /groups/:id/join',
    event: 'community.member.joined',
    call: () => request(app).post(`/community/groups/${GROUP}/join`).set('Authorization', `Bearer ${TOKEN}`),
  },
  {
    name: 'community.ts POST /global-groups/:id/join',
    event: 'community.member.joined',
    call: () => request(app).post(`/community/global-groups/${GROUP}/join`).set('Authorization', `Bearer ${TOKEN}`),
  },
  {
    name: 'match-feedback.ts POST /:id/feedback',
    event: 'match.feedback.like',
    call: () =>
      request(app).post(`/match/${MATCH}/feedback`).set('Authorization', `Bearer ${TOKEN}`).send({ feedback_type: 'like' }),
  },
  {
    name: 'matchmaking.ts POST /:id/state',
    event: 'match.state.accepted',
    call: () =>
      request(app).post(`/match/${MATCH}/state`).set('Authorization', `Bearer ${TOKEN}`).send({ state: 'accepted' }),
  },
];

describe.each(rawBearerSites)('$name', ({ event, call }) => {
  it('flag off ⇒ DEFAULT_TENANT_ID, no tenant lookup (today)', async () => {
    setFlag(false);
    const res = await call();
    expect(res.status).toBe(200);
    await flush();
    expect(primaryMock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0]).toBe(MAXINA);
    expect(dispatchMock.mock.calls[0][1]).toBe(event);
  });

  it("flag on ⇒ the token sub's primary tenant, never Maxina", async () => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status: 'found', tenantId: TENANT_B, role: 'community', source: 'primary' });
    const res = await call();
    expect(res.status).toBe(200);
    await flush();
    expect(primaryMock).toHaveBeenCalledWith(ACTOR);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0]).toBe(TENANT_B);
    expect(dispatchMock.mock.calls[0][1]).toBe(event);
  });

  it.each(['none', 'unavailable'])("flag on, primary tenant '%s' ⇒ no dispatch, no Maxina tag", async (status) => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status });
    const res = await call();
    expect(res.status).toBe(200);
    await flush();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('a failed user-scoped call dispatches nothing (actor read only after it succeeded)', () => {
  it('community.ts /groups/:id/join RPC error ⇒ no tenant lookup, no dispatch', async () => {
    setFlag(true);
    (communityRepo.joinCommunityGroupRpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await request(app).post(`/community/groups/${GROUP}/join`).set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(502);
    await flush();
    expect(primaryMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ── community.ts /global-groups/:id/view: actor = the verified identity ─────

describe('community.ts POST /global-groups/:id/view (requireAuth identity)', () => {
  const view = (identity: Record<string, unknown>) =>
    request(app).post(`/community/global-groups/${GROUP}/view`).set('x-test-identity', JSON.stringify(identity));

  it('flag off ⇒ DEFAULT_TENANT_ID (today)', async () => {
    setFlag(false);
    await view({ user_id: ACTOR, tenant_id: TENANT_B });
    await flush();
    expect(dispatchMock).toHaveBeenCalledWith(MAXINA, 'user.group.viewed', { user_id: ACTOR, group_id: GROUP });
    expect(primaryMock).not.toHaveBeenCalled();
  });

  it("flag on ⇒ the identity's tenant, no lookup", async () => {
    setFlag(true);
    await view({ user_id: ACTOR, tenant_id: TENANT_B });
    await flush();
    expect(dispatchMock).toHaveBeenCalledWith(TENANT_B, 'user.group.viewed', { user_id: ACTOR, group_id: GROUP });
    expect(primaryMock).not.toHaveBeenCalled();
  });

  it('flag on, identity without tenant ⇒ primary tenant of the user', async () => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status: 'found', tenantId: TENANT_B, role: null, source: 'primary' });
    await view({ user_id: ACTOR, tenant_id: null });
    await flush();
    expect(primaryMock).toHaveBeenCalledWith(ACTOR);
    expect(dispatchMock).toHaveBeenCalledWith(TENANT_B, 'user.group.viewed', { user_id: ACTOR, group_id: GROUP });
  });

  it('flag on, identity without tenant and no membership ⇒ no dispatch', async () => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status: 'none' });
    await view({ user_id: ACTOR, tenant_id: null });
    await flush();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ── admin-signups.ts /log-result: actor = the NEW user (auth_user_id) ───────

describe('admin-signups.ts POST /log-result', () => {
  const logResult = () =>
    request(app).post('/admin-signups/log-result').send({ attempt_id: 'att-1', status: 'onboarded', auth_user_id: NEW_USER });

  it('flag off ⇒ user.signup.completed tagged DEFAULT_TENANT_ID (today)', async () => {
    setFlag(false);
    const res = await logResult();
    expect(res.status).toBe(200);
    expect(primaryMock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(MAXINA, 'user.signup.completed', { user_id: NEW_USER, attempt_id: 'att-1' });
  });

  it("flag on ⇒ tagged with auth_user_id's primary tenant (incl. referral + shared-link events)", async () => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status: 'found', tenantId: TENANT_B, role: null, source: 'primary' });
    (signupsRepo.fetchAttemptReferralInfo as jest.Mock).mockResolvedValue({
      data: { referral_code: 'REF1', utm_source: 'sharing_link', utm_campaign: 'share_x' },
    });
    const res = await logResult();
    expect(res.status).toBe(200);
    expect(primaryMock).toHaveBeenCalledWith(NEW_USER);
    expect(dispatchMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [TENANT_B, 'user.signup.completed'],
      [TENANT_B, 'user.signup.referral'],
      [TENANT_B, 'user.signup.shared_link'],
    ]);
  });

  it('flag on, unresolvable ⇒ no dispatch, response unchanged', async () => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status: 'unavailable' });
    const res = await logResult();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ── groups-events-tools.ts join_group: the fallback site ────────────────────

describe('groups-events-tools.ts join_group (fallback site)', () => {
  /** Chainable Supabase mock: one result per table (enough for join_group). */
  function makeSb(tableResults: Record<string, Array<{ data: unknown }>>): SupabaseClient {
    const counters: Record<string, number> = {};
    const from = jest.fn((table: string) => {
      const queue = tableResults[table] ?? [{ data: null }];
      const i = counters[table] ?? 0;
      counters[table] = i + 1;
      const resolved = { data: queue[Math.min(i, queue.length - 1)].data, error: null };
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'ilike', 'or', 'order', 'limit', 'update', 'insert', 'upsert', 'delete']) {
        b[m] = jest.fn(() => b);
      }
      b.maybeSingle = jest.fn(async () => resolved);
      b.single = jest.fn(async () => resolved);
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resolved).then(ok, ko);
      return b;
    });
    return { from, rpc: jest.fn(async () => ({ data: [], error: null })) } as unknown as SupabaseClient;
  }
  const sb = () =>
    makeSb({
      global_community_groups: [
        { data: [{ id: GROUP, name: 'Morning Walkers', description: null, member_count: 3, is_public: true }] },
      ],
      global_community_group_members: [{ data: null }, { data: null }],
    });

  it.each([false, true])('id.tenant_id present ⇒ that tenant on flag=%s (no regression), no lookup', async (on) => {
    setFlag(on);
    const res = await tool_join_group({ query: 'walkers' }, { user_id: ACTOR, tenant_id: TENANT_B, role: 'community' } as any, sb());
    expect(res.ok).toBe(true);
    expect(primaryMock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(TENANT_B, 'community.member.joined', { group_id: GROUP, user_id: ACTOR });
  });

  it('id.tenant_id absent, flag off ⇒ DEFAULT_TENANT_ID (today)', async () => {
    setFlag(false);
    await tool_join_group({ query: 'walkers' }, { user_id: ACTOR, tenant_id: null, role: 'community' } as any, sb());
    expect(dispatchMock).toHaveBeenCalledWith(MAXINA, 'community.member.joined', { group_id: GROUP, user_id: ACTOR });
  });

  it("id.tenant_id absent, flag on ⇒ the user's primary tenant", async () => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status: 'found', tenantId: TENANT_B, role: null, source: 'primary' });
    await tool_join_group({ query: 'walkers' }, { user_id: ACTOR, tenant_id: null, role: 'community' } as any, sb());
    expect(primaryMock).toHaveBeenCalledWith(ACTOR);
    expect(dispatchMock).toHaveBeenCalledWith(TENANT_B, 'community.member.joined', { group_id: GROUP, user_id: ACTOR });
  });

  it('id.tenant_id absent, flag on, unresolvable ⇒ no dispatch, the join still succeeds', async () => {
    setFlag(true);
    primaryMock.mockResolvedValue({ status: 'none' });
    const res = await tool_join_group({ query: 'walkers' }, { user_id: ACTOR, tenant_id: null, role: 'community' } as any, sb());
    expect(res.ok).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
