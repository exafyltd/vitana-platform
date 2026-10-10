// VTID-05055 — HTTP tests for the member's side of a partner link
// (Health Hub Phase 0 / D8), mounted at /api/v1/partner-health/member.
//
// Contract under test (requireAuthWithTenant — the member's own identity):
//   - auth: 401 without a user token (staging probes exactly this)
//   - GET /link-requests: the caller's pending rows only, scoped by user_id and
//     NOT by the session tenant; the response never carries raw_payload,
//     candidate ids or any staff identity; a missing column (migration not
//     applied) answers an empty list
//   - POST /link-requests/:id/confirm: another member's row → 404 (no
//     existence leak); happy path creates the link + order through
//     fn_confirm_partner_link_request (via link-confirmation.ts); a second
//     confirm → 409; a member of tenant B confirms a request proposed in
//     tenant A; migration missing → 503
//   - POST /link-requests/:id/decline: status + declined array, row stays
//     unresolved, health_test.link_declined emitted
//   - index.ts mounts the router exactly once

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

const MEMBER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_MEMBER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    const byToken: Record<string, any> = {
      // The member's current session is in tenant B; proposals may come from tenant A.
      'Bearer member-1': { user_id: MEMBER_ID, tenant_id: TENANT_B },
      'Bearer member-2': { user_id: OTHER_MEMBER_ID, tenant_id: TENANT_A },
    };
    const identity = byToken[req.headers.authorization ?? ''];
    if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = identity;
    return next();
  },
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

type Ctx = { op: string; args: any[]; filters: Array<[string, ...any[]]> };
let inboxHandler: (ctx: Ctx) => any;
let rpcHandler: (fn: string, params: any) => any;
let calls: Array<{ table: string } & Ctx>;
let rpcCalls: Array<{ fn: string; params: any }>;

function makeFakeSupabase() {
  return {
    from(table: string) {
      if (table !== 'partner_health_result_inbox') throw new Error(`Unexpected table in test: ${table}`);
      let op = 'select';
      let opArgs: any[] = [];
      const filters: Array<[string, ...any[]]> = [];
      const chain: any = {};
      for (const m of ['eq', 'in', 'or', 'order', 'limit']) {
        chain[m] = (...args: any[]) => { filters.push([m, ...args]); return chain; };
      }
      const run = () => {
        const ctx = { op, args: opArgs, filters };
        calls.push({ table, ...ctx });
        return inboxHandler(ctx);
      };
      chain.select = (...args: any[]) => { if (op === 'select') opArgs = args; return chain; };
      chain.update = (...args: any[]) => { op = 'update'; opArgs = args; return chain; };
      chain.insert = () => { throw new Error('member routes never insert directly'); };
      chain.maybeSingle = () => Promise.resolve(run());
      chain.single = () => Promise.resolve(run());
      chain.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
      return chain;
    },
    rpc(fn: string, params: any) {
      rpcCalls.push({ fn, params });
      return Promise.resolve(rpcHandler(fn, params));
    },
  };
}

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeFakeSupabase() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/partner-health-member').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/partner-health/member', router);
  return app;
}

const BASE = '/api/v1/partner-health/member/link-requests';

beforeEach(() => {
  jest.clearAllMocks();
  emitOasisEventMock.mockResolvedValue({ ok: true });
  calls = [];
  rpcCalls = [];
  inboxHandler = () => ({ data: null, error: null });
  rpcHandler = () => ({ data: null, error: { message: 'unexpected rpc' } });
});

describe('auth', () => {
  it.each([
    ['get', BASE],
    ['post', `${BASE}/inbox-1/confirm`],
    ['post', `${BASE}/inbox-1/decline`],
  ])('%s %s → 401 without a user token, nothing read or written', async (method, url) => {
    const r = await (request(makeApp()) as any)[method](url);
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('GET /link-requests', () => {
  it("lists only the caller's pending rows, scoped by user_id and not by the session tenant", async () => {
    inboxHandler = () => ({
      data: [{
        id: 'inbox-1', proposed_test_name: 'Cholesterol Panel', proposed_at: '2026-10-10T08:00:00Z',
        partner_registry: { display_name: 'DoctorBox' },
        // Even if the database returned more columns, none of them may leave.
        raw_payload: { external_customer_ref: 'SECRET' }, candidate_user_ids: ['x'],
        proposed_by_admin_id: 'staff-1', resolved_by_admin_id: 'staff-2', proposed_tenant_id: TENANT_A,
      }],
      error: null,
    });
    const r = await request(makeApp()).get(BASE).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      requests: [{ id: 'inbox-1', partner_display_name: 'DoctorBox', test_name: 'Cholesterol Panel', proposed_at: '2026-10-10T08:00:00Z' }],
    });
    for (const forbidden of ['proposed_by_admin_id', 'resolved_by_admin_id', 'candidate_user_ids', 'raw_payload', 'SECRET', 'staff-1']) {
      expect(JSON.stringify(r.body)).not.toContain(forbidden);
    }
    const q = calls[0];
    expect(q.args[0]).not.toMatch(/raw_payload|candidate_user_ids|proposed_by_admin_id|resolved_by_admin_id/);
    expect(q.filters).toEqual(expect.arrayContaining([
      ['eq', 'proposed_user_id', MEMBER_ID],
      ['eq', 'member_link_status', 'pending_member'],
      ['eq', 'resolved', false],
    ]));
    // Never scoped to the session's tenant (round-1 F11).
    expect(q.filters.some((f) => /tenant/.test(String(f[1])))).toBe(false);
  });

  it('answers an empty list when the proposal columns are missing (migration not applied)', async () => {
    inboxHandler = () => ({ data: null, error: { code: '42703', message: 'column partner_health_result_inbox.proposed_user_id does not exist' } });
    const r = await request(makeApp()).get(BASE).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, requests: [] });
  });

  it('500 on any other database error (never an empty list that hides a fault)', async () => {
    inboxHandler = () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const r = await request(makeApp()).get(BASE).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('LINK_REQUESTS_UNAVAILABLE');
  });
});

describe('POST /link-requests/:id/confirm', () => {
  it("404 for another member's row — no existence leak, no RPC", async () => {
    // The scoped read (id + proposed_user_id = caller) finds nothing.
    inboxHandler = () => ({ data: null, error: null });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/confirm`).set('Authorization', 'Bearer member-2');
    expect(r.status).toBe(404);
    expect(calls[0].filters).toEqual(expect.arrayContaining([['eq', 'id', 'inbox-1'], ['eq', 'proposed_user_id', OTHER_MEMBER_ID]]));
    expect(rpcCalls).toHaveLength(0);
  });

  it('happy path: creates the link + order through fn_confirm_partner_link_request, member is the actor', async () => {
    inboxHandler = () => ({ data: { id: 'inbox-1', member_link_status: 'pending_member', resolved: false }, error: null });
    rpcHandler = () => ({ data: { ok: true, order_id: 'order-1', link_id: 'link-1' }, error: null });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/confirm`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: 'confirmed', order_id: 'order-1' });
    expect(rpcCalls).toEqual([{ fn: 'fn_confirm_partner_link_request', params: { p_inbox_id: 'inbox-1', p_user_id: MEMBER_ID } }]);
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-05055', type: 'health_test.order_created', actor_id: MEMBER_ID,
      payload: { inbox_id: 'inbox-1', order_id: 'order-1', link_id: 'link-1', confirmed_by: 'member' },
    }));
  });

  it('a member whose session is in tenant B confirms a request proposed in tenant A (the stored tenant is re-checked in the RPC)', async () => {
    inboxHandler = () => ({ data: { id: 'inbox-1', member_link_status: 'pending_member', resolved: false }, error: null });
    rpcHandler = () => ({ data: { ok: true, order_id: 'order-a', link_id: 'link-a' }, error: null });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/confirm`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(200);
    // The session tenant (B) is never passed: the function uses proposed_tenant_id.
    expect(JSON.stringify(rpcCalls[0].params)).not.toContain(TENANT_B);
  });

  it('second confirm → 409 (row no longer pending), no RPC', async () => {
    inboxHandler = () => ({ data: { id: 'inbox-1', member_link_status: 'confirmed', resolved: true }, error: null });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/confirm`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('race: the RPC reports not_pending → 409', async () => {
    inboxHandler = () => ({ data: { id: 'inbox-1', member_link_status: 'pending_member', resolved: false }, error: null });
    rpcHandler = () => ({ data: { ok: false, code: 'not_pending' }, error: null });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/confirm`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(409);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('503 when the migration is not applied — never the old direct link', async () => {
    inboxHandler = () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'proposed_user_id' column of 'partner_health_result_inbox' in the schema cache" } });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/confirm`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('MEMBER_CONFIRMATION_UNAVAILABLE');
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('POST /link-requests/:id/decline', () => {
  it('sets declined + appends the member to member_declined_user_ids, leaves the row unresolved, emits link_declined', async () => {
    inboxHandler = ({ op }) => {
      if (op === 'update') return { data: [{ id: 'inbox-1' }], error: null };
      return { data: { id: 'inbox-1', member_link_status: 'pending_member', member_declined_user_ids: ['someone-earlier'], resolved: false }, error: null };
    };
    const r = await request(makeApp()).post(`${BASE}/inbox-1/decline`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: 'declined' });
    const update = calls.find((c) => c.op === 'update')!;
    expect(update.args[0]).toMatchObject({ member_link_status: 'declined', member_declined_user_ids: ['someone-earlier', MEMBER_ID] });
    expect(update.args[0]).not.toHaveProperty('resolved');
    expect(update.filters).toEqual(expect.arrayContaining([
      ['eq', 'proposed_user_id', MEMBER_ID],
      ['eq', 'member_link_status', 'pending_member'],
      ['eq', 'resolved', false],
    ]));
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-05055', type: 'health_test.link_declined', actor_id: MEMBER_ID, payload: { inbox_id: 'inbox-1' },
    }));
    expect(rpcCalls).toHaveLength(0);
  });

  it("404 for another member's row", async () => {
    inboxHandler = () => ({ data: null, error: null });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/decline`).set('Authorization', 'Bearer member-2');
    expect(r.status).toBe(404);
    expect(calls.some((c) => c.op === 'update')).toBe(false);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('409 when no longer pending', async () => {
    inboxHandler = () => ({ data: { id: 'inbox-1', member_link_status: 'confirmed', member_declined_user_ids: [], resolved: true }, error: null });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/decline`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(409);
  });

  it('503 when the migration is not applied', async () => {
    inboxHandler = () => ({ data: null, error: { code: '42703', message: 'column partner_health_result_inbox.member_link_status does not exist' } });
    const r = await request(makeApp()).post(`${BASE}/inbox-1/decline`).set('Authorization', 'Bearer member-1');
    expect(r.status).toBe(503);
  });
});

describe('route mount', () => {
  it('index.ts mounts the member router exactly once, at /api/v1/partner-health/member', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    const mounts = src.match(/mountRouterSync\([^)]*partnerHealthMemberRouter[^)]*\)/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toContain("'/api/v1/partner-health/member'");
    expect(src).toContain("require('./routes/partner-health-member')");
  });
});
