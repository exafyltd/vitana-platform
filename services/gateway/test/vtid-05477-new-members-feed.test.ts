// VTID-05477 — GET /api/v1/community/new-members
// The "new members" card must never list a test, service or bot account, the
// caller, a member who withdrew the opt-in, or anyone older than 7 days. When the
// exclusion lookup fails the route fails closed (503), never shows a possibly-test
// account.
import express from 'express';
import request from 'supertest';

type Row = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
  is_visible: boolean;
  community_intro_opt_in: boolean;
};

let profiles: Row[] = [];
let serviceBots: string[] = [];
let testActors: string[] = [];
let failTable: string | null = null;
let lastLimit: number | null = null;

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const row = (id: string, o: Partial<Row> = {}): Row => ({
  user_id: id,
  display_name: `Member ${id}`,
  avatar_url: null,
  bio: null,
  created_at: ago(1),
  is_visible: true,
  community_intro_opt_in: true,
  ...o,
});

function makeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let orderCol: string | null = null;
      let limit = Infinity;
      const q: any = {
        select: () => q,
        eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
        gte: (c: string, v: any) => (filters.push((r) => r[c] >= v), q),
        order: (c: string) => ((orderCol = c), q),
        limit: (n: number) => ((limit = n), (lastLimit = n), q),
        then: (resolve: any, reject: any) => {
          if (failTable === table) return resolve({ data: null, error: { message: `${table} down` } });
          let src: any[] =
            table === 'global_community_profiles'
              ? profiles
              : table === 'service_bot_accounts'
                ? serviceBots.map((user_id) => ({ user_id }))
                : table === 'notification_test_actors'
                  ? testActors.map((user_id) => ({ user_id }))
                  : [];
          src = src.filter((r) => filters.every((f) => f(r)));
          if (orderCol) src = [...src].sort((a, b) => (a[orderCol!] < b[orderCol!] ? 1 : -1));
          return Promise.resolve({ data: src.slice(0, limit), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization === 'Bearer caller') {
      req.identity = { user_id: 'caller', email: 'c@example.com', tenant_id: 't1' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeSupabase() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/community-new-members').default;

function app() {
  const a = express();
  a.use('/api/v1', router);
  return a;
}
const get = (qs = '') => request(app()).get(`/api/v1/community/new-members${qs}`).set('Authorization', 'Bearer caller');

beforeEach(() => {
  profiles = [];
  serviceBots = [];
  testActors = [];
  failTable = null;
  lastLimit = null;
});

describe('GET /community/new-members', () => {
  it('401 JSON without a token', async () => {
    const res = await request(app()).get('/api/v1/community/new-members');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('lists opted-in visible members from the last 7 days, newest first, with the card fields only', async () => {
    profiles = [row('a', { created_at: ago(3) }), row('b', { created_at: ago(1), bio: 'hi' })];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.members.map((m: any) => m.user_id)).toEqual(['b', 'a']);
    expect(Object.keys(res.body.members[0]).sort()).toEqual(['avatar_url', 'bio', 'created_at', 'display_name', 'user_id']);
  });

  it('empty list is 200 with members []', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, members: [] });
  });

  it('excludes service bots and test actors, and still fills the limit with real members', async () => {
    serviceBots = ['bot'];
    testActors = ['tester'];
    profiles = [
      row('bot', { created_at: ago(0.1) }),
      row('tester', { created_at: ago(0.2) }),
      row('real1', { created_at: ago(0.3) }),
      row('real2', { created_at: ago(0.4) }),
    ];
    const res = await get('?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: any) => m.user_id)).toEqual(['real1', 'real2']);
  });

  it('excludes the caller', async () => {
    profiles = [row('caller'), row('other', { created_at: ago(2) })];
    const res = await get();
    expect(res.body.members.map((m: any) => m.user_id)).toEqual(['other']);
  });

  it('excludes a member who has not opted in or withdrew the opt-in on the next call', async () => {
    profiles = [row('yes'), row('no', { community_intro_opt_in: false })];
    expect((await get()).body.members.map((m: any) => m.user_id)).toEqual(['yes']);
    profiles[0].community_intro_opt_in = false; // withdrawal
    expect((await get()).body.members).toEqual([]);
  });

  it('excludes hidden profiles and members older than 7 days', async () => {
    profiles = [row('hidden', { is_visible: false }), row('old', { created_at: ago(8) }), row('ok', { created_at: ago(6) })];
    expect((await get()).body.members.map((m: any) => m.user_id)).toEqual(['ok']);
  });

  it('clamps the limit to 1..5 and defaults to 5', async () => {
    profiles = Array.from({ length: 9 }, (_, i) => row(`m${i}`, { created_at: ago(1 + i / 100) }));
    expect((await get()).body.members).toHaveLength(5);
    expect((await get('?limit=99')).body.members).toHaveLength(5);
    expect((await get('?limit=0')).body.members).toHaveLength(1);
    expect((await get('?limit=abc')).body.members).toHaveLength(5);
    expect((await get('?limit=2')).body.members).toHaveLength(2);
  });

  it.each(['service_bot_accounts', 'notification_test_actors'])(
    'fails closed with 503 exclusion_lookup_failed when %s cannot be read',
    async (table) => {
      profiles = [row('a')];
      failTable = table;
      const res = await get();
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual({ ok: false, error: 'exclusion_lookup_failed' });
    },
  );

  it('does not filter by tenant (mirrors the browser query)', async () => {
    profiles = [row('other-tenant-member')];
    expect((await get()).body.members).toHaveLength(1);
  });
});
