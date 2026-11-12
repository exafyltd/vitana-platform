/**
 * VTID-05559 (live-room-edit-cohost / gateway-cohost) — route tests for
 * PATCH /rooms/:id/sessions/current and the verified-identity change on
 * open-lobby. Database and fetch are mocked by URL; no live service.
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
    verifyAndExtractIdentity: async () => null,
  };
});
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../src/services/notification-service', () => ({ notifyUserAsync: jest.fn(), notifyUsersAsync: jest.fn() }));
jest.mock('../src/services/entitlement-service', () => ({ checkEntitlement: jest.fn(), recordUsage: jest.fn(), recordPaywallEvent: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: async (_s: unknown, ids: string[]) => new Map(ids.map((id) => [id, 'de'])),
  getUserLocale: async () => 'de',
}));

// Co-host checks use the service-role client; tests control its answers.
let mockSupa: any = null;
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockSupa }));

import liveRouter from '../src/routes/live';

const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = 'sess-0001';
const CREATOR = 'creator-user';
const STRANGER = 'stranger-user';
const COHOST = 'cohost-user';
const COHOST_ID = '33333333-3333-4333-8333-333333333333';
const FUTURE = '2099-01-01T18:00:00.000Z';

type Setup = {
  status?: string;
  grants?: unknown[];
  listingOk?: boolean;
};

function installFetch(s: Setup & { grantsFail?: boolean }) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
    if (url.includes('/rpc/live_room_get_state')) {
      return json({ room: { id: ROOM, host_user_id: CREATOR, current_session_id: SESSION, status: s.status ?? 'scheduled' }, session: { id: SESSION, status: s.status ?? 'scheduled', starts_at: FUTURE, ends_at: '2099-01-01T19:00:00.000Z', access_level: 'public' } });
    }
    if (url.includes('/rpc/live_room_get')) {
      return json({ id: ROOM, host_user_id: CREATOR, tenant_id: 'tenant-1', current_session_id: SESSION, status: s.status ?? 'scheduled' });
    }
    if (url.includes('/live_room_access_grants')) return s.grantsFail ? json({ message: 'x' }, 500) : json(s.grants ?? []);
    if (url.includes('/community_live_streams')) return s.listingOk === false ? json({ message: 'boom' }, 500) : json({}, 204);
    if (url.includes('/live_room_sessions') || url.includes('/live_rooms')) return json({}, 204);
    return json({ ok: true });
  });
  return calls;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/live', liveRouter);
  return a;
}

beforeEach(() => {
  mockSupa = { rpc: async () => ({ data: false, error: null }) };
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'service-key';
  // The daily route answers 503 before its host check when no Daily key is set; the host check is what these tests cover.
  process.env.DAILY_API_KEY = process.env.DAILY_API_KEY || 'test-daily-key';
});

describe('PATCH /rooms/:id/sessions/current', () => {
  const url = `/api/v1/live/rooms/${ROOM}/sessions/current`;

  it('401 without a login', async () => {
    installFetch({});
    const r = await request(app()).patch(url).send({ session_title: 'x' });
    expect(r.status).toBe(401);
  });

  it('400 for a field the endpoint does not accept', async () => {
    installFetch({});
    const r = await request(app()).patch(url).set('Authorization', `Bearer valid-${CREATOR}`).send({ not_a_field: 1 });
    expect(r.status).toBe(400);
  });

  it('403 NOT_HOST for a member who is not the creator', async () => {
    installFetch({});
    const r = await request(app()).patch(url).set('Authorization', `Bearer valid-${STRANGER}`).send({ session_title: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('NOT_HOST');
  });

  it('409 SESSION_LOCKED for a start change while the session is live', async () => {
    installFetch({ status: 'live' });
    const r = await request(app()).patch(url).set('Authorization', `Bearer valid-${CREATOR}`).send({ starts_at: FUTURE });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('SESSION_LOCKED');
    expect(r.body.fields).toEqual(['starts_at']);
  });

  it('409 SESSION_CLOSED for an ended session', async () => {
    installFetch({ status: 'ended' });
    const r = await request(app()).patch(url).set('Authorization', `Bearer valid-${CREATOR}`).send({ session_title: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('SESSION_CLOSED');
  });

  it('a scheduled title edit writes the session row and the listing, and returns 200', async () => {
    const calls = installFetch({});
    const r = await request(app()).patch(url).set('Authorization', `Bearer valid-${CREATOR}`).send({ session_title: 'Sunday Brunch' });
    expect(r.status).toBe(200);
    const sessionWrite = calls.find((c) => c.url.includes('/live_room_sessions') && c.method === 'PATCH');
    const listingWrite = calls.find((c) => c.url.includes('/community_live_streams') && c.method === 'PATCH');
    expect(sessionWrite?.body).toEqual({ session_title: 'Sunday Brunch' });
    expect(listingWrite?.body).toEqual({ title: 'Sunday Brunch' });
  });

  it('502 LISTING_SYNC_FAILED when the listing write fails (the session row was already written)', async () => {
    installFetch({ listingOk: false });
    const r = await request(app()).patch(url).set('Authorization', `Bearer valid-${CREATOR}`).send({ session_title: 'x' });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('LISTING_SYNC_FAILED');
  });

  it('409 HAS_ACCESS_GRANTS when the access level changes and a valid grant exists', async () => {
    installFetch({ grants: [{ id: 'g1' }] });
    const r = await request(app()).patch(url).set('Authorization', `Bearer valid-${CREATOR}`).send({ access_level: 'group' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('HAS_ACCESS_GRANTS');
  });
});

describe('PATCH start time guard', () => {
  it('400 START_IN_PAST for a start time already gone', async () => {
    installFetch({});
    const r = await request(app())
      .patch(`/api/v1/live/rooms/${ROOM}/sessions/current`)
      .set('Authorization', `Bearer valid-${CREATOR}`)
      .send({ starts_at: '2001-01-01T10:00:00.000Z' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('START_IN_PAST');
  });
});

describe('POST /rooms/:id/cancel', () => {
  it('401 without a login, whatever the body says', async () => {
    installFetch({});
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/cancel`).send({ user_id: CREATOR });
    expect(r.status).toBe(401);
  });
});

describe('POST /rooms/:id/open-lobby', () => {
  it('401 without a login, whatever the body says', async () => {
    installFetch({});
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/open-lobby`).send({ user_id: CREATOR });
    expect(r.status).toBe(401);
  });
});

describe('co-host routes (VTID-05559)', () => {
  it('a listed co-host is not refused as NOT_HOST when opening the lobby', async () => {
    installFetch({});
    mockSupa = { rpc: async (fn: string) => ({ data: fn === 'live_room_is_host' ? true : [], error: null }) };
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/open-lobby`).set('Authorization', `Bearer valid-${COHOST}`).send({});
    expect(r.body.error).not.toBe('NOT_HOST');
  });

  it('an unlisted member opening the lobby is 403 NOT_HOST, even when the body names the creator', async () => {
    installFetch({});
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/open-lobby`).set('Authorization', `Bearer valid-${STRANGER}`).send({ user_id: CREATOR });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('NOT_HOST');
  });

  it('daily: an unlisted member is 403 NOT_HOST', async () => {
    installFetch({});
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/daily`).set('Authorization', `Bearer valid-${STRANGER}`).send({});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('NOT_HOST');
  });

  it('daily: a listed co-host is not refused as NOT_HOST', async () => {
    installFetch({});
    mockSupa = { rpc: async (fn: string) => ({ data: fn === 'live_room_is_host' ? true : [], error: null }) };
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/daily`).set('Authorization', `Bearer valid-${COHOST}`).send({});
    expect(r.body.error).not.toBe('NOT_HOST');
  });

  it('create: co-hosts with no validation client are 503 CO_HOST_VALIDATION_UNAVAILABLE', async () => {
    installFetch({});
    mockSupa = null;
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/sessions`).set('Authorization', `Bearer valid-${CREATOR}`)
      .send({ starts_at: FUTURE, co_hosts: [COHOST_ID] });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('CO_HOST_VALIDATION_UNAVAILABLE');
  });

  it('create: a co-host the room does not accept is 400 INVALID_CO_HOSTS with the dropped id', async () => {
    installFetch({});
    mockSupa = { rpc: async () => ({ data: [], error: null }) };
    const r = await request(app()).post(`/api/v1/live/rooms/${ROOM}/sessions`).set('Authorization', `Bearer valid-${CREATOR}`)
      .send({ starts_at: FUTURE, co_hosts: [COHOST_ID] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_CO_HOSTS');
    expect(r.body.dropped).toEqual([COHOST_ID]);
  });

  it('PATCH: a failed grant check is 502 GRANT_CHECK_FAILED and writes nothing', async () => {
    const calls = installFetch({ grantsFail: true });
    const r = await request(app()).patch(`/api/v1/live/rooms/${ROOM}/sessions/current`)
      .set('Authorization', `Bearer valid-${CREATOR}`).send({ access_level: 'group' });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('GRANT_CHECK_FAILED');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('enter: a listed co-host gets host rights; an unlisted member does not', async () => {
    installFetch({});
    mockSupa = { rpc: async (fn: string, params: any) => ({ data: fn === 'live_room_is_host' && params.p_user_id === COHOST, error: null }) };
    const cohost = await request(app()).post(`/api/v1/live/rooms/${ROOM}/enter`).set('Authorization', `Bearer valid-${COHOST}`).send({});
    expect(cohost.status).toBe(200);
    expect(cohost.body.is_host).toBe(true);

    const stranger = await request(app()).post(`/api/v1/live/rooms/${ROOM}/enter`).set('Authorization', `Bearer valid-${STRANGER}`).send({});
    expect(stranger.status).toBe(200);
    expect(stranger.body.is_host).not.toBe(true);
  });
});
