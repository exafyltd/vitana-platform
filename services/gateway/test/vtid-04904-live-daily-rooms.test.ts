/**
 * VTID-04904 (LR-A1) — Daily rooms that can be joined.
 *
 * Covers: per-user rate-limit key incl. the forged-token fallback, the live
 * limiter end to end (30 per user, forged tokens share the IP bucket),
 * ensureRoom create / exists→update exp+privacy, expiry fallbacks, owner vs
 * participant meeting tokens, /daily 401/403/503/host, the health flag and
 * the metadata merge in createSession.
 *
 * No live service is called: global fetch is the jest mock from
 * test/__mocks__/setup-tests.ts, routed per URL below.
 */

import express from 'express';
import request from 'supertest';

// ── Auth: a token verifies only when it is "valid-<user id>" ──────────────
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
jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
  notifyUsersAsync: jest.fn(),
}));
jest.mock('../src/services/entitlement-service', () => ({
  checkEntitlement: jest.fn(),
  recordUsage: jest.fn(),
  recordPaywallEvent: jest.fn(),
}));
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const chain: any = {
      select: () => chain, eq: () => chain, neq: () => chain, is: () => chain, in: () => chain,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (r: any) => r({ data: [], error: null }),
    };
    return { from: () => chain };
  },
}));

import {
  computeDailyRoomExpiry,
  DailyClient,
  dailyRoomNameFor,
} from '../src/services/daily-client';

const ROOM = '11111111-2222-3333-4444-555555555555';
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

/** Routes Supabase RPC + Daily API calls to in-memory answers. */
function installFetch(opts: {
  rpc?: Record<string, (body: any) => unknown>;
  dailyCreateStatus?: number;
} = {}) {
  calls = [];
  fetchMock.mockImplementation(async (url: string, init: any = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const rpc = /\/rest\/v1\/rpc\/(\w+)$/.exec(url);
    if (rpc) {
      const h = opts.rpc?.[rpc[1]];
      return resp(200, h ? h(body) : { ok: true });
    }
    if (url === 'https://api.daily.co/v1/rooms' && method === 'POST') {
      const st = opts.dailyCreateStatus ?? 200;
      return st === 200
        ? resp(200, { url: `https://vitana.daily.co/${body.name}`, name: body.name })
        : resp(st, { error: 'invalid-request-error', info: `a room named ${body.name} already exists` });
    }
    const upd = /^https:\/\/api\.daily\.co\/v1\/rooms\/([\w-]+)$/.exec(url);
    if (upd && method === 'POST') return resp(200, { url: `https://vitana.daily.co/${upd[1]}`, name: upd[1] });
    if (url === 'https://api.daily.co/v1/meeting-tokens') return resp(200, { token: `tok-${body.properties.is_owner ? 'owner' : 'guest'}` });
    return resp(200, {});
  });
}

const NOW = Date.parse('2026-10-05T12:00:00Z');
const H = 3600;

describe('computeDailyRoomExpiry', () => {
  const nowS = NOW / 1000;
  test('ends_at wins, plus 2 h', () => {
    expect(computeDailyRoomExpiry({ startsAt: '2026-10-10T10:00:00Z', endsAt: '2026-10-10T12:00:00Z', nowMs: NOW }))
      .toBe(Date.parse('2026-10-10T12:00:00Z') / 1000 + 2 * H);
  });
  test('no ends_at: starts_at + duration_minutes + 2 h', () => {
    expect(computeDailyRoomExpiry({ startsAt: '2026-10-10T10:00:00Z', durationMinutes: 90, nowMs: NOW }))
      .toBe(Date.parse('2026-10-10T10:00:00Z') / 1000 + 90 * 60 + 2 * H);
  });
  test('duration defaults to 60 minutes', () => {
    expect(computeDailyRoomExpiry({ startsAt: '2026-10-10T10:00:00Z', durationMinutes: null, nowMs: NOW }))
      .toBe(Date.parse('2026-10-10T10:00:00Z') / 1000 + 60 * 60 + 2 * H);
  });
  test('never earlier than now + 4 h (session already over / nothing known)', () => {
    expect(computeDailyRoomExpiry({ startsAt: '2026-10-01T10:00:00Z', nowMs: NOW })).toBe(nowS + 4 * H);
    expect(computeDailyRoomExpiry({ nowMs: NOW })).toBe(nowS + 4 * H);
    expect(computeDailyRoomExpiry({ startsAt: 'garbage', endsAt: 'garbage', nowMs: NOW })).toBe(nowS + 4 * H);
  });
});

describe('DailyClient', () => {
  beforeAll(() => { process.env.DAILY_API_KEY = 'test-daily-key'; });

  test('ensureRoom creates a PRIVATE room with the given exp', async () => {
    installFetch();
    const r = await new DailyClient().ensureRoom(ROOM, { expiresAt: 1_900_000_000 });
    expect(r).toEqual({ roomUrl: `https://vitana.daily.co/vitana-${ROOM}`, roomName: `vitana-${ROOM}`, exp: 1_900_000_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ name: `vitana-${ROOM}`, privacy: 'private', properties: { exp: 1_900_000_000 } });
  });

  test('ensureRoom on an existing room updates exp + privacy instead of returning the stale room', async () => {
    installFetch({ dailyCreateStatus: 400 });
    const r = await new DailyClient().ensureRoom(ROOM, { expiresAt: 1_900_000_123 });
    expect(r.exp).toBe(1_900_000_123);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.daily.co/v1/rooms',
      `POST https://api.daily.co/v1/rooms/${dailyRoomNameFor(ROOM)}`,
    ]);
    expect(calls[1].body).toEqual({ privacy: 'private', properties: { exp: 1_900_000_123 } });
  });

  test('ensureRoom surfaces a failed update', async () => {
    installFetch({ dailyCreateStatus: 400 });
    fetchMock.mockImplementationOnce(async () => resp(400, { error: 'x', info: 'exists' }))
      .mockImplementationOnce(async () => resp(500, { error: 'boom' }));
    await expect(new DailyClient().ensureRoom(ROOM, { expiresAt: 1 })).rejects.toThrow('Daily.co update room error: boom');
  });

  test('meeting tokens: owner for the host, participant otherwise, both carry exp + user', async () => {
    installFetch();
    const c = new DailyClient();
    await c.createMeetingToken('vitana-x', { userId: HOST, isOwner: true, exp: 123 });
    await c.createMeetingToken('vitana-x', { userId: VIEWER, userName: 'Vi', exp: 456 });
    expect(calls[0].body.properties).toEqual({ room_name: 'vitana-x', exp: 123, is_owner: true, user_id: HOST });
    expect(calls[1].body.properties).toEqual({ room_name: 'vitana-x', exp: 456, is_owner: false, user_name: 'Vi', user_id: VIEWER });
  });
});

describe('live routes', () => {
  let app: express.Express;
  let live: typeof import('../src/routes/live');

  beforeAll(() => {
    process.env.DAILY_API_KEY = 'test-daily-key';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    live = require('../src/routes/live');
    app = express();
    app.use(express.json());
    app.use('/api/v1/live', live.default);
  });

  const roomRow = (host: string, metadata: Record<string, unknown> = {}) => ({
    id: ROOM, host_user_id: host, title: 'Room', access_level: 'public', metadata,
  });

  describe('liveRateLimitKey', () => {
    const key = (req: any) => live.liveRateLimitKey(req);
    test('verified user id', () => {
      expect(key({ identity: { user_id: 'u1' }, headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '10.0.0.1' })).toBe('user:u1');
    });
    test('forged token (no verified identity) falls back to the first X-Forwarded-For hop', () => {
      expect(key({ headers: { authorization: 'Bearer forged', 'x-forwarded-for': '1.2.3.4, 10.0.0.9' }, ip: '10.0.0.1' })).toBe('ip:1.2.3.4');
    });
    test('no XFF → req.ip', () => {
      expect(key({ headers: {}, ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
    });
  });

  describe('POST /rooms/:id/daily', () => {
    test('401 without a token, and with a token that does not verify', async () => {
      installFetch();
      await request(app).post(`/api/v1/live/rooms/${ROOM}/daily`).set('X-Forwarded-For', '9.0.0.1').expect(401);
      await request(app).post(`/api/v1/live/rooms/${ROOM}/daily`).set('X-Forwarded-For', '9.0.0.1')
        .set('Authorization', 'Bearer forged').expect(401);
      expect(calls).toHaveLength(0);
    });

    test('403 NOT_HOST for a viewer — no URL, no Daily call', async () => {
      installFetch({ rpc: { live_room_get: () => [roomRow(HOST, { daily_room_url: 'https://vitana.daily.co/x' })] } });
      const r = await request(app).post(`/api/v1/live/rooms/${ROOM}/daily`).set('X-Forwarded-For', '9.0.0.2')
        .set('Authorization', `Bearer valid-${VIEWER}`).expect(403);
      expect(r.body).toEqual({ ok: false, error: 'NOT_HOST' });
      expect(JSON.stringify(r.body)).not.toContain('daily.co');
      expect(calls.some((c) => c.url.includes('api.daily.co'))).toBe(false);
    });

    test('host: refreshes exp from the session, merges metadata, returns an owner token', async () => {
      let written: any = null;
      installFetch({
        dailyCreateStatus: 400,
        rpc: {
          live_room_get: () => [roomRow(HOST, { price: 12, description: 'keep me', daily_room_url: `https://vitana.daily.co/vitana-${ROOM}` })],
          live_room_get_state: () => ({ ok: true, room: {}, session: { starts_at: '2030-01-01T10:00:00Z', ends_at: '2030-01-01T11:00:00Z' } }),
          live_room_update_metadata: (b) => { written = b; return true; },
        },
      });
      const r = await request(app).post(`/api/v1/live/rooms/${ROOM}/daily`).set('X-Forwarded-For', '9.0.0.3')
        .set('Authorization', `Bearer valid-${HOST}`).expect(200);
      const exp = Date.parse('2030-01-01T11:00:00Z') / 1000 + 2 * H;
      expect(r.body).toMatchObject({ ok: true, token: 'tok-owner', is_host: true, expires_at: exp, already_existed: true });
      const upd = calls.find((c) => c.url.endsWith(`/rooms/vitana-${ROOM}`));
      expect(upd?.body).toEqual({ privacy: 'private', properties: { exp } });
      expect(written.p_metadata).toMatchObject({ price: 12, description: 'keep me', daily_room_exp: exp, video_provider: 'daily_co' });
      const tok = calls.find((c) => c.url.endsWith('/meeting-tokens'));
      expect(tok?.body.properties).toMatchObject({ is_owner: true, user_id: HOST, exp });
    });

    test('503 DAILY_NOT_CONFIGURED when the key is missing', async () => {
      installFetch();
      delete process.env.DAILY_API_KEY;
      try {
        const r = await request(app).post(`/api/v1/live/rooms/${ROOM}/daily`).set('X-Forwarded-For', '9.0.0.4')
          .set('Authorization', `Bearer valid-${HOST}`).expect(503);
        expect(r.body.error).toBe('DAILY_NOT_CONFIGURED');
      } finally {
        process.env.DAILY_API_KEY = 'test-daily-key';
      }
    });
  });

  describe('per-user limiter on /daily (30 / 15 min)', () => {
    const hit = (ip: string, auth?: string) => {
      const r = request(app).post(`/api/v1/live/rooms/${ROOM}/daily`).set('X-Forwarded-For', ip);
      return auth ? r.set('Authorization', auth) : r;
    };

    test('one user is limited after 30; another user on the SAME IP is not', async () => {
      installFetch({ rpc: { live_room_get: () => [roomRow(HOST)] } });
      for (let i = 0; i < 30; i++) await hit('8.8.8.8', 'Bearer valid-limited-user').expect(403);
      await hit('8.8.8.8', 'Bearer valid-limited-user').expect(429);
      await hit('8.8.8.8', 'Bearer valid-other-user').expect(403);
    });

    test('forged tokens never get their own bucket — they share the IP bucket', async () => {
      installFetch();
      for (let i = 0; i < 30; i++) await hit('7.7.7.7', `Bearer forged-${i}`).expect(401);
      await hit('7.7.7.7', 'Bearer forged-new').expect(429);
      await hit('7.7.7.7', 'Bearer valid-fresh-user').expect(403);
    });
  });

  describe('GET /health', () => {
    test('daily_configured reflects presence of the key only', async () => {
      process.env.DAILY_API_KEY = 'secret-value';
      const on = await request(app).get('/api/v1/live/health').expect(200);
      expect(on.body.daily_configured).toBe(true);
      expect(JSON.stringify(on.body)).not.toContain('secret-value');
      delete process.env.DAILY_API_KEY;
      const off = await request(app).get('/api/v1/live/health').expect(200);
      expect(off.body.daily_configured).toBe(false);
      process.env.DAILY_API_KEY = 'test-daily-key';
    });
  });
});

describe('RoomSessionManager.createSession', () => {
  test('ensures a private room for THIS session and merges metadata instead of replacing it', async () => {
    process.env.DAILY_API_KEY = 'test-daily-key';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RoomSessionManager } = require('../src/services/room-session-manager');
    let written: any = null;
    installFetch({
      rpc: {
        live_room_get_state: () => ({ ok: true, room: { status: 'idle' }, session: null }),
        live_room_create_session: () => ({ ok: true, session_id: 'sess-1', status: 'scheduled' }),
        live_room_get: () => [{ id: ROOM, metadata: { price: 20, description: 'paid talk' } }],
        live_room_update_metadata: (b) => { written = b; return true; },
      },
    });
    const m = new RoomSessionManager();
    const r = await m.createSession(ROOM, {
      starts_at: '2030-02-01T18:00:00Z',
      metadata: { duration_minutes: 45 },
    }, 'user-token');
    expect(r).toMatchObject({ ok: true, sessionId: 'sess-1', dailyRoomUrl: `https://vitana.daily.co/vitana-${ROOM}` });
    const exp = Date.parse('2030-02-01T18:00:00Z') / 1000 + 45 * 60 + 2 * H;
    const create = calls.find((c) => c.url === 'https://api.daily.co/v1/rooms');
    expect(create?.body).toMatchObject({ privacy: 'private', properties: { exp } });
    expect(written.p_metadata).toEqual({
      price: 20,
      description: 'paid talk',
      daily_room_url: `https://vitana.daily.co/vitana-${ROOM}`,
      daily_room_name: `vitana-${ROOM}`,
      daily_room_exp: exp,
      video_provider: 'daily_co',
    });
  });
});
