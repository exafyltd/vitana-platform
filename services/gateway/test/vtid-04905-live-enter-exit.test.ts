/**
 * VTID-04905 (LR-A2) — enter/exit, lifecycle, notifications.
 *
 * Harness: the live router on an express app, auth middleware mocked
 * (token "valid-<user>" verifies), Supabase RPC/REST + Daily.co answered by
 * the global fetch mock (test/__mocks__/setup-tests.ts) routed per URL, and
 * an in-memory supabase-js client that records every query. No live service.
 *
 * Covers: the enter access matrix (public, paid without/with grant, not
 * live, host starts a scheduled session, lobby wait, join-gate errors), exit
 * scoped to the current session, viewer_count sync, auto-transitions guarded
 * in both directions, the stream_type enum + ends_at default, repository
 * column names and localized notification texts/deep links.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const idFrom = (req: any): string | null => {
    const h = req.headers?.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    return t.startsWith('valid-') ? t.slice(6) : null;
  };
  return {
    optionalAuth: (req: any, _res: any, next: any) => {
      const id = idFrom(req);
      if (id) req.identity = { user_id: id, tenant_id: 'tenant-1' };
      next();
    },
    requireAuth: (req: any, res: any, next: any) => {
      const id = idFrom(req);
      if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = { user_id: id, tenant_id: 'tenant-1' };
      next();
    },
    verifyAndExtractIdentity: async (token: string) =>
      token.startsWith('valid-') ? { identity: { user_id: token.slice(6), tenant_id: 'tenant-1' } } : null,
  };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
const notifyUserAsync = jest.fn();
jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: (...a: unknown[]) => notifyUserAsync(...a),
  notifyUsersAsync: jest.fn(),
}));
jest.mock('../src/services/entitlement-service', () => ({
  checkEntitlement: jest.fn(),
  recordUsage: jest.fn(),
  recordPaywallEvent: jest.fn(),
}));
jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: async (_s: unknown, ids: string[]) => new Map(ids.map((id) => [id, id.endsWith('-en') ? 'en' : 'de'])),
  getUserLocale: async () => 'de',
}));

// ── In-memory supabase-js: records queries, answers from `tables` ─────────
type Query = { table: string; select?: string; filters: Array<[string, string, unknown]> };
const queries: Query[] = [];
let tables: Record<string, (q: Query) => unknown> = {};
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const q: Query = { table, filters: [] };
      queries.push(q);
      const result = () => {
        const data = tables[table] ? tables[table](q) : null;
        return { data, error: null };
      };
      const chain: any = {
        select: (cols: string) => { q.select = cols; return chain; },
        eq: (c: string, v: unknown) => { q.filters.push(['eq', c, v]); return chain; },
        neq: (c: string, v: unknown) => { q.filters.push(['neq', c, v]); return chain; },
        in: (c: string, v: unknown) => { q.filters.push(['in', c, v]); return chain; },
        single: async () => result(),
        maybeSingle: async () => result(),
        then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
      };
      return chain;
    },
  }),
}));

import * as repo from '../src/routes/live-repository';

const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = 'sess-0001';
const HOST = 'host-user';
const VIEWER = 'viewer-user';
const fetchMock = global.fetch as unknown as jest.Mock;

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];

function resp(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFetch(rpc: Record<string, (body: any) => unknown> = {}, rest: Record<string, (c: Call) => unknown> = {}) {
  calls = [];
  fetchMock.mockImplementation(async (url: string, init: any = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { url, method, body };
    calls.push(call);
    const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(url);
    if (m) return resp(200, rpc[m[1]] ? rpc[m[1]](body) : { ok: true });
    const t = /\/rest\/v1\/(\w+)\?/.exec(url);
    if (t && rest[t[1]]) return resp(200, rest[t[1]](call));
    if (url === 'https://api.daily.co/v1/rooms') return resp(200, { url: `https://vitana.daily.co/${body.name}`, name: body.name });
    if (url === 'https://api.daily.co/v1/meeting-tokens') return resp(200, { token: body.properties.is_owner ? 'tok-owner' : 'tok-guest' });
    return resp(200, []);
  });
}

const rpcNames = () => calls.filter((c) => c.url.includes('/rpc/')).map((c) => c.url.split('/rpc/')[1]);

/** live_room_get_state answer with a mutable room status. */
function stateFor(opts: {
  status: string; session?: Record<string, unknown> | null; grant?: boolean; host?: string;
}) {
  return () => ({
    ok: true,
    room: { id: ROOM, status: opts.status, host_user_id: opts.host ?? HOST, current_session_id: opts.session === null ? null : SESSION },
    session: opts.session === null ? null : {
      id: SESSION, status: opts.status, access_level: 'public',
      starts_at: '2030-01-01T10:00:00Z', ends_at: '2030-01-01T11:00:00Z', lobby_buffer_minutes: 15,
      ...(opts.session || {}),
    },
    counts: { in_room: 0 },
    viewer: { has_access_grant: opts.grant === true },
  });
}

let app: express.Express;

beforeAll(() => {
  process.env.DAILY_API_KEY = 'test-daily-key';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const live = require('../src/routes/live');
  app = express();
  app.use(express.json());
  app.use('/api/v1/live', live.default);
});

beforeEach(() => {
  queries.length = 0;
  tables = {};
  notifyUserAsync.mockClear();
});

const enter = (user?: string) => {
  const r = request(app).post(`/api/v1/live/rooms/${ROOM}/enter`);
  return user ? r.set('Authorization', `Bearer valid-${user}`) : r;
};

describe('POST /rooms/:id/enter — access matrix', () => {
  test('401 without a verified token (no RPC, no Daily call)', async () => {
    installFetch();
    await enter().expect(401);
    await request(app).post(`/api/v1/live/rooms/${ROOM}/enter`).set('Authorization', 'Bearer forged').expect(401);
    expect(calls).toHaveLength(0);
  });

  test('public live room: viewer gets a participant token, attendance via live_room_join_session, viewer_count synced', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'live' }),
      live_room_join_session: () => ({ ok: true, role: 'guest', lobby_status: 'admitted' }),
      live_room_get_counts: () => ({ in_room: 3, lobby_waiting: 0 }),
    });
    const r = await enter(VIEWER).expect(200);
    expect(r.body).toMatchObject({
      ok: true, is_host: false, token: 'tok-guest', lobby_status: 'admitted', session_id: SESSION,
      daily_room_url: `https://vitana.daily.co/vitana-${ROOM}`, counts: { in_room: 3 },
    });
    const join = calls.find((c) => c.url.endsWith('/rpc/live_room_join_session'));
    expect(join?.body).toEqual({ p_room_id: ROOM, p_session_id: SESSION });
    const tok = calls.find((c) => c.url.endsWith('/meeting-tokens'));
    expect(tok?.body.properties).toMatchObject({ is_owner: false, user_id: VIEWER, room_name: `vitana-${ROOM}` });
    const create = calls.find((c) => c.url === 'https://api.daily.co/v1/rooms');
    expect(create?.body.privacy).toBe('private');
    const vc = calls.find((c) => c.method === 'PATCH' && c.url.includes('/community_live_streams?id=eq.'));
    expect(vc?.body).toEqual({ viewer_count: 3 });
    // viewer never writes room metadata (host-only RPC)
    expect(rpcNames()).not.toContain('live_room_update_metadata');
  });

  test('paid room without a grant → 402, no attendance, no token', async () => {
    installFetch({ live_room_get_state: stateFor({ status: 'live', session: { access_level: 'group' }, grant: false }) });
    const r = await enter(VIEWER).expect(402);
    expect(r.body.error).toBe('PAYMENT_REQUIRED');
    expect(rpcNames()).not.toContain('live_room_join_session');
    expect(calls.some((c) => c.url.includes('api.daily.co'))).toBe(false);
  });

  test('paid room with a grant → 200', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'live', session: { access_level: 'group' }, grant: true }),
      live_room_join_session: () => ({ ok: true, role: 'guest', lobby_status: 'admitted' }),
      live_room_get_counts: () => ({ in_room: 1 }),
    });
    const r = await enter(VIEWER).expect(200);
    expect(r.body.token).toBe('tok-guest');
  });

  test('the join RPC still refuses a paid room without a grant → 402', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'live', session: { access_level: 'group' }, grant: true }),
      live_room_join_session: () => ({ ok: false, error: 'PAYMENT_REQUIRED' }),
    });
    await enter(VIEWER).expect(402);
  });

  test('no current session → 409 NOT_LIVE', async () => {
    installFetch({ live_room_get_state: stateFor({ status: 'idle', session: null }) });
    const r = await enter(VIEWER).expect(409);
    expect(r.body.error).toBe('NOT_LIVE');
  });

  test('scheduled session, viewer → 409 NOT_LIVE (no transition attempted)', async () => {
    installFetch({ live_room_get_state: stateFor({ status: 'scheduled', session: { starts_at: '2099-01-01T10:00:00Z' } }) });
    const r = await enter(VIEWER).expect(409);
    expect(r.body.error).toBe('NOT_LIVE');
    expect(rpcNames()).not.toContain('live_room_transition_status');
  });

  test('host entering a scheduled session starts it (scheduled → lobby → live) and gets an owner token', async () => {
    let status = 'scheduled';
    const transitions: any[] = [];
    let metadataWritten: any = null;
    installFetch({
      live_room_get_state: () => stateFor({ status, session: { starts_at: '2099-01-01T10:00:00Z' } })(),
      live_room_transition_status: (b) => { transitions.push(b); status = b.p_new_status; return { ok: true, new_status: status }; },
      live_room_join_session: () => ({ ok: true, role: 'host', lobby_status: 'admitted' }),
      live_room_get_counts: () => ({ in_room: 1 }),
      live_room_get: () => [{ id: ROOM, metadata: { price: 5 } }],
      live_room_update_metadata: (b) => { metadataWritten = b; return true; },
    });
    const r = await enter(HOST).expect(200);
    expect(r.body).toMatchObject({ ok: true, is_host: true, token: 'tok-owner' });
    expect(transitions.map((t) => `${t.p_expected_old_status}->${t.p_new_status}`)).toEqual(['scheduled->lobby', 'lobby->live']);
    const listingLive = calls.find((c) => c.method === 'PATCH' && c.url.includes('community_live_streams') && c.body?.status === 'live');
    expect(listingLive).toBeDefined();
    expect(metadataWritten.p_metadata).toMatchObject({ price: 5, video_provider: 'daily_co' });
  });

  test('host start that the RPC refuses → no listing flip, 409', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'lobby' }),
      live_room_transition_status: () => ({ ok: false, error: 'CONFLICT' }),
    });
    await enter(HOST).expect(409);
    expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('community_live_streams'))).toBe(false);
  });

  test('lobby, not admitted yet → 200 without URL or token', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'lobby' }),
      live_room_join_session: () => ({ ok: true, role: 'guest', lobby_status: 'waiting' }),
      live_room_get_counts: () => ({ in_room: 0, lobby_waiting: 1 }),
    });
    const r = await enter(VIEWER).expect(200);
    expect(r.body).toMatchObject({ ok: true, lobby_status: 'waiting' });
    expect(r.body.token).toBeUndefined();
    expect(r.body.daily_room_url).toBeUndefined();
  });

  test.each([
    ['HOST_NOT_PRESENT', 409],
    ['ROOM_FULL', 409],
    ['BANNED', 403],
    ['ROOM_NOT_ACTIVE', 409],
  ])('join gate %s → %i', async (err, code) => {
    installFetch({
      live_room_get_state: stateFor({ status: 'live' }),
      live_room_join_session: () => ({ ok: false, error: err }),
    });
    const r = await enter(VIEWER).expect(code as number);
    expect(r.body.error).toBe(err === 'ROOM_NOT_ACTIVE' ? 'NOT_LIVE' : err);
  });

  test('first entry notifies the host in their language, deep link to the room page', async () => {
    tables.live_rooms = () => ({ title: 'Morning Yoga', tenant_id: 'tenant-1', host_user_id: HOST });
    installFetch({
      live_room_get_state: stateFor({ status: 'live', session: { session_title: 'Morning Yoga' } }),
      live_room_join_session: () => ({ ok: true, role: 'guest', lobby_status: 'admitted' }),
      live_room_get_counts: () => ({ in_room: 2 }),
    });
    await enter(VIEWER).expect(200);
    expect(notifyUserAsync).toHaveBeenCalledTimes(1);
    const [uid, tenant, type, payload] = notifyUserAsync.mock.calls[0];
    expect([uid, tenant, type]).toEqual([HOST, 'tenant-1', 'someone_joined_live_room']);
    expect(payload.title).toBe('Jemand ist in deinem Raum');
    expect(payload.body).toBe('Jemand Neues ist in „Morning Yoga“ dabei.');
    expect(payload.data.url).toBe(`/comm/live-rooms/${ROOM}/view`);
  });

  test('no notification when the viewer was already in the session', async () => {
    tables.live_rooms = () => ({ title: 'X', tenant_id: 'tenant-1', host_user_id: HOST });
    installFetch({
      live_room_get_state: stateFor({ status: 'live' }),
      live_room_join_session: () => ({ ok: true, role: 'guest', lobby_status: 'admitted', already_joined: true }),
      live_room_get_counts: () => ({ in_room: 2 }),
    });
    await enter(VIEWER).expect(200);
    expect(notifyUserAsync).not.toHaveBeenCalled();
  });
});

describe('POST /rooms/:id/exit', () => {
  test('closes attendance of THIS session only (service role), never calls live_room_leave, syncs viewer_count', async () => {
    installFetch(
      {
        live_room_get_state: stateFor({ status: 'live' }),
        live_room_get_counts: () => ({ in_room: 4 }),
      },
      { live_room_attendance: () => [{ id: 'att-1' }] },
    );
    const r = await request(app).post(`/api/v1/live/rooms/${ROOM}/exit`).set('Authorization', `Bearer valid-${VIEWER}`).expect(200);
    expect(r.body).toMatchObject({ ok: true, left: true, session_id: SESSION, counts: { in_room: 4 } });
    const upd = calls.find((c) => c.method === 'PATCH' && c.url.includes('/live_room_attendance?'));
    expect(upd).toBeDefined();
    const qs = upd!.url.split('?')[1];
    expect(qs).toContain(`live_room_id=eq.${ROOM}`);
    expect(qs).toContain(`session_id=eq.${SESSION}`);
    expect(qs).toContain(`user_id=eq.${VIEWER}`);
    expect(qs).toContain('left_at=is.null');
    expect(Object.keys(upd!.body)).toEqual(['left_at']);
    expect(rpcNames()).not.toContain('live_room_leave');
    expect(calls.find((c) => c.method === 'PATCH' && c.url.includes('community_live_streams'))?.body).toEqual({ viewer_count: 4 });
  });

  test('no active session → ok, nothing written', async () => {
    installFetch({ live_room_get_state: stateFor({ status: 'idle', session: null }) });
    const r = await request(app).post(`/api/v1/live/rooms/${ROOM}/exit`).set('Authorization', `Bearer valid-${VIEWER}`).expect(200);
    expect(r.body).toMatchObject({ ok: true, left: false });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('401 without auth', async () => {
    installFetch();
    await request(app).post(`/api/v1/live/rooms/${ROOM}/exit`).expect(401);
  });
});

describe('checkAutoTransitions — listing follows only successful transitions', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RoomSessionManager } = require('../src/services/room-session-manager');
  const listingPatches = () => calls.filter((c) => c.method === 'PATCH' && c.url.includes('community_live_streams'));

  test('scheduled → lobby refused (viewer token) → listing untouched', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'scheduled', session: { starts_at: '2000-01-01T10:00:00Z' } }),
      live_room_transition_status: () => ({ ok: false, error: 'NOT_HOST' }),
    });
    await new RoomSessionManager().checkAutoTransitions(ROOM, 'viewer-token');
    expect(rpcNames()).toContain('live_room_transition_status');
    expect(listingPatches()).toHaveLength(0);
  });

  test('scheduled → lobby applied → listing live', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'scheduled', session: { starts_at: '2000-01-01T10:00:00Z' } }),
      live_room_transition_status: () => ({ ok: true }),
    });
    await new RoomSessionManager().checkAutoTransitions(ROOM, 'host-token');
    expect(listingPatches().map((c) => c.body.status)).toEqual(['live']);
  });

  test('live → ended refused → listing untouched; applied → listing ended', async () => {
    const past = { ends_at: '2000-01-01T11:00:00Z' };
    installFetch({ live_room_get_state: stateFor({ status: 'live', session: past }), live_room_end_session: () => ({ ok: false, error: 'NOT_HOST' }) });
    await new RoomSessionManager().checkAutoTransitions(ROOM, 'viewer-token');
    expect(listingPatches()).toHaveLength(0);

    installFetch({ live_room_get_state: stateFor({ status: 'live', session: past }), live_room_end_session: () => ({ ok: true }) });
    await new RoomSessionManager().checkAutoTransitions(ROOM, 'host-token');
    expect(listingPatches().map((c) => c.body.status)).toEqual(['ended']);
  });
});

describe('POST /rooms/:id/sessions — lifecycle fields', () => {
  const goLive = (body: Record<string, unknown>) =>
    request(app).post(`/api/v1/live/rooms/${ROOM}/sessions`).set('Authorization', `Bearer valid-${HOST}`).send(body);

  test('stream_type outside audio|video → 400', async () => {
    installFetch();
    const r = await goLive({ starts_at: '2030-03-01T18:00:00.000Z', metadata: { stream_type: 'screen' } }).expect(400);
    expect(r.body.details).toContain('stream_type');
  });

  test('ends_at defaults to starts_at + duration_minutes; stream_type written to the listing', async () => {
    let created: any = null;
    let upsert: any = null;
    installFetch(
      {
        live_room_get_state: () => ({ ok: true, room: { status: 'idle' }, session: null }),
        live_room_create_session: (b) => { created = b; return { ok: true, session_id: SESSION, status: 'scheduled' }; },
        live_room_get: () => [{ id: ROOM, metadata: {} }],
      },
    );
    const impl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      if (url.endsWith('/rest/v1/community_live_streams') && init.method === 'POST') {
        upsert = JSON.parse(init.body);
        return resp(201, {});
      }
      return impl(url, init);
    });
    await goLive({ starts_at: '2030-03-01T18:00:00.000Z', metadata: { stream_type: 'video', duration_minutes: 90 } }).expect(201);
    expect(created.p_payload.ends_at).toBe('2030-03-01T19:30:00.000Z');
    expect(upsert.stream_type).toBe('video');
  });

  test('without duration the session ends 60 minutes after start; explicit ends_at is kept', async () => {
    let created: any = null;
    installFetch({
      live_room_get_state: () => ({ ok: true, room: { status: 'idle' }, session: null }),
      live_room_create_session: (b) => { created = b; return { ok: true, session_id: SESSION, status: 'scheduled' }; },
      live_room_get: () => [{ id: ROOM, metadata: {} }],
    });
    await goLive({ starts_at: '2030-03-01T18:00:00.000Z' }).expect(201);
    expect(created.p_payload.ends_at).toBe('2030-03-01T19:00:00.000Z');
    await goLive({ starts_at: '2030-03-01T18:00:00.000Z', ends_at: '2030-03-01T18:20:00.000Z' }).expect(201);
    expect(created.p_payload.ends_at).toBe('2030-03-01T18:20:00.000Z');
  });
});

describe('live-repository — real column names (B9)', () => {
  const sb = () => require('@supabase/supabase-js').createClient();

  test('host lookup reads live_rooms.host_user_id', async () => {
    tables.live_rooms = () => ({ title: 'T', tenant_id: 't', host_user_id: HOST });
    const { data } = await repo.fetchLiveRoomTitleTenantHost(sb(), ROOM);
    expect(queries[0]).toMatchObject({ table: 'live_rooms', select: 'title, tenant_id, host_user_id' });
    expect((data as any).host_user_id).toBe(HOST);
  });

  test('attendees come from live_room_attendance by live_room_id (+ session)', async () => {
    tables.live_room_attendance = () => [{ user_id: 'a' }];
    await repo.fetchLiveRoomAttendeesExcluding(sb(), ROOM, HOST, SESSION);
    expect(queries[0].table).toBe('live_room_attendance');
    expect(queries[0].filters).toEqual([['eq', 'live_room_id', ROOM], ['eq', 'session_id', SESSION], ['neq', 'user_id', HOST]]);
  });

  test('listing tenant comes from live_rooms (community_live_streams has no tenant_id)', async () => {
    tables.community_live_streams = () => ({ title: 'Listing title' });
    tables.live_rooms = () => ({ title: 'Room title', tenant_id: 'tenant-9' });
    const { data } = await repo.fetchLiveStreamTitleTenant(sb(), ROOM);
    expect(data).toEqual({ title: 'Listing title', tenant_id: 'tenant-9' });
    const streamQ = queries.find((q) => q.table === 'community_live_streams');
    expect(streamQ?.select).toBe('title');
    expect(queries.find((q) => q.table === 'live_rooms')?.select).toBe('title, tenant_id');
  });
});

describe('POST /rooms/:id/end — summary notification', () => {
  test('attendees of the ended session get localized texts + the room deep link', async () => {
    tables.live_rooms = () => ({ title: 'Breathwork', tenant_id: 'tenant-1', host_user_id: HOST });
    tables.live_room_attendance = () => [{ user_id: 'u1' }, { user_id: 'u2-en' }, { user_id: 'u1' }];
    installFetch({ live_room_end_session: () => ({ ok: true, ended_session_id: SESSION }) });
    await request(app).post(`/api/v1/live/rooms/${ROOM}/end`).set('Authorization', `Bearer valid-${HOST}`).expect(200);
    const attQ = queries.find((q) => q.table === 'live_room_attendance');
    expect(attQ?.filters).toEqual([['eq', 'live_room_id', ROOM], ['eq', 'session_id', SESSION], ['neq', 'user_id', HOST]]);
    expect(notifyUserAsync).toHaveBeenCalledTimes(2);
    const byUser = Object.fromEntries(notifyUserAsync.mock.calls.map((c) => [c[0], c[3]]));
    expect(byUser.u1.title).toBe('Zusammenfassung verfügbar');
    expect(byUser.u1.body).toBe('„Breathwork“ ist beendet. Schau dir die Zusammenfassung an!');
    expect(byUser['u2-en'].body).toBe('"Breathwork" has ended. Check out the summary!');
    expect(byUser.u1.data.url).toBe(`/comm/live-rooms/${ROOM}/view`);
  });
});
