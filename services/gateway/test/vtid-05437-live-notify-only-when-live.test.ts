/**
 * Live rooms: go-live notifications only when the room is really live (#4539, commit 6028392a).
 *
 * Proves the behaviour of notifyRoomWentLive() in routes/live.ts:
 *  - POST /rooms/:id/sessions sends no "live_room_starting" push for a scheduled session;
 *  - a session that comes back live/lobby notifies followers and "Notify me" subscribers;
 *  - the host entering a scheduled session (startForHost succeeds) notifies them;
 *  - a refused host start, and a viewer entering an already-live room, send no go-live push;
 *  - the host is never told about their own room.
 *
 * Harness copied from test/vtid-04905-live-enter-exit.test.ts: the live router on an express app, auth
 * mocked (token "valid-<user>" verifies), Supabase RPC/REST + Daily.co answered by the global fetch mock,
 * notification-service and supabase-js in memory. No live service, nothing is written anywhere.
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
  bulkGetUserLocales: async (_s: unknown, ids: string[]) => new Map(ids.map((id) => [id, 'de'])),
  getUserLocale: async () => 'de',
}));

// ── In-memory supabase-js: answers from `tables`, applies eq/neq on user_id ──
type Query = { table: string; select?: string; filters: Array<[string, string, unknown]> };
let tables: Record<string, (q: Query) => unknown> = {};
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      const q: Query = { table, filters: [] };
      const result = () => ({ data: tables[table] ? tables[table](q) : null, error: null });
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

const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = 'sess-0001';
const HOST = 'host-user';
const VIEWER = 'viewer-user';
const FOLLOWER = 'follower-user';
const SUBSCRIBER = 'subscriber-user';
const fetchMock = global.fetch as unknown as jest.Mock;

function resp(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFetch(rpc: Record<string, (body: any) => unknown> = {}) {
  fetchMock.mockImplementation(async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const m = /\/rest\/v1\/rpc\/(\w+)$/.exec(url);
    if (m) return resp(200, rpc[m[1]] ? rpc[m[1]](body) : { ok: true });
    if (url === 'https://api.daily.co/v1/rooms') return resp(200, { url: `https://vitana.daily.co/${body.name}`, name: body.name });
    if (url === 'https://api.daily.co/v1/meeting-tokens') return resp(200, { token: body.properties.is_owner ? 'tok-owner' : 'tok-guest' });
    return resp(200, []);
  });
}

function stateFor(opts: { status: string; session?: Record<string, unknown> }) {
  return () => ({
    ok: true,
    room: { id: ROOM, status: opts.status, host_user_id: HOST, current_session_id: SESSION },
    session: {
      id: SESSION, status: opts.status, access_level: 'public',
      starts_at: '2099-01-01T10:00:00Z', ends_at: '2099-01-01T11:00:00Z', lobby_buffer_minutes: 15,
      ...(opts.session || {}),
    },
    counts: { in_room: 0 },
    viewer: { has_access_grant: false },
  });
}

/** Rows minus any user the query excluded with .neq('user_id', x). */
const excluding = (rows: string[]) => (q: Query) => {
  const out = q.filters.filter(([op, c]) => op === 'neq' && c === 'user_id').map(([, , v]) => v);
  return rows.filter((u) => !out.includes(u)).map((user_id) => ({ user_id }));
};

/** Followers (attended before) and Notify-me subscribers both list the host too: the route must drop them. */
function seedAudience() {
  tables.live_rooms = () => ({ title: 'Morning Yoga', tenant_id: 'tenant-1', host_user_id: HOST });
  tables.community_live_streams = () => ({ title: 'Morning Yoga' });
  tables.live_room_attendance = excluding([FOLLOWER, HOST]);
  tables.live_stream_subscribers = excluding([SUBSCRIBER, HOST]);
}

const goLive = () => notifyUserAsync.mock.calls.filter((c) => c[2] === 'live_room_starting');
const goLiveRecipients = () => goLive().map((c) => c[0]).sort();

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
  tables = {};
  notifyUserAsync.mockClear();
  seedAudience();
});

// The session-create path reads the host id from the JWT payload, so the bearer must be JWT-shaped.
const hostJwt = `valid-x.${Buffer.from(JSON.stringify({ sub: HOST })).toString('base64')}.sig`;
const createSession = () =>
  request(app)
    .post(`/api/v1/live/rooms/${ROOM}/sessions`)
    .set('Authorization', `Bearer ${hostJwt}`)
    .send({ starts_at: '2099-01-01T10:00:00.000Z' });

const enter = (user: string) =>
  request(app).post(`/api/v1/live/rooms/${ROOM}/enter`).set('Authorization', `Bearer valid-${user}`);

describe('POST /rooms/:id/sessions — go-live push only when the session is running', () => {
  const sessionRpc = (status: string) => ({
    live_room_get_state: () => ({ ok: true, room: { status: 'idle' }, session: null }),
    live_room_create_session: () => ({ ok: true, session_id: SESSION, status }),
    live_room_get: () => [{ id: ROOM, metadata: {} }],
  });

  test('a scheduled session notifies nobody', async () => {
    installFetch(sessionRpc('scheduled'));
    await createSession().expect(201);
    expect(goLive()).toHaveLength(0);
  });

  test.each(['live', 'lobby'])('a %s session notifies followers and subscribers, never the host', async (status) => {
    installFetch(sessionRpc(status));
    await createSession().expect(201);
    expect(goLiveRecipients()).toEqual([FOLLOWER, SUBSCRIBER].sort());
    for (const c of goLive()) {
      expect(c[1]).toBe('tenant-1');
      expect(c[3].data.url).toBe(`/comm/live-rooms/${ROOM}/view`);
    }
  });
});

describe('POST /rooms/:id/enter — go-live push when the host starts the room', () => {
  test('host entering a scheduled session (start succeeds) notifies followers and subscribers, never the host', async () => {
    let status = 'scheduled';
    installFetch({
      live_room_get_state: () => stateFor({ status })(),
      live_room_transition_status: (b) => { status = b.p_new_status; return { ok: true, new_status: status }; },
      live_room_join_session: () => ({ ok: true, role: 'host', lobby_status: 'admitted' }),
      live_room_get_counts: () => ({ in_room: 1 }),
      live_room_get: () => [{ id: ROOM, metadata: {} }],
    });
    await enter(HOST).expect(200);
    expect(goLiveRecipients()).toEqual([FOLLOWER, SUBSCRIBER].sort());
  });

  test('a host start the RPC refuses notifies nobody', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'lobby' }),
      live_room_transition_status: () => ({ ok: false, error: 'CONFLICT' }),
    });
    await enter(HOST).expect(409);
    expect(goLive()).toHaveLength(0);
  });

  test('a viewer entering an already-live room sends no go-live push', async () => {
    installFetch({
      live_room_get_state: stateFor({ status: 'live' }),
      live_room_join_session: () => ({ ok: true, role: 'guest', lobby_status: 'admitted' }),
      live_room_get_counts: () => ({ in_room: 2 }),
    });
    await enter(VIEWER).expect(200);
    expect(goLive()).toHaveLength(0);
  });
});
