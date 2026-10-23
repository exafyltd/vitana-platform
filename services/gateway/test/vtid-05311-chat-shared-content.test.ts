/**
 * VTID-05311 (messenger-ux-v2/api-shared-content, plan I6) — shared posts,
 * events, products and profiles in chats.
 *
 * Two in-memory databases: `serviceDb` is everything that exists (what the
 * service-role client sees), `userDb[viewer]` is what each viewer's RLS lets
 * them read (what the user-scoped client sees). The preview must come from the
 * viewer's own view; the service client may only answer "does it exist" and
 * "is this a test/service account".
 */
import request from 'supertest';
import express from 'express';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const GROUP = '44444444-4444-4444-8444-444444444444';
const POST = 'aaaaaaaa-0000-4000-8000-000000000001';
const HIDDEN_POST = 'aaaaaaaa-0000-4000-8000-000000000002';
const GONE = 'aaaaaaaa-0000-4000-8000-000000000003';
const EVENT = 'aaaaaaaa-0000-4000-8000-000000000004';
const PRODUCT = 'aaaaaaaa-0000-4000-8000-000000000005';
const BOT = 'aaaaaaaa-0000-4000-8000-000000000006';

type Row = Record<string, any>;
type Db = Record<string, Row[]>;
let serviceDb: Db = {};
let userDb: Record<string, Db> = {};
const serviceSelects: Array<{ table: string; cols: string }> = [];
let seq = 0;

class Q {
  private f: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private cols = '*';
  private lim: number | null = null;
  constructor(private db: Db, private table: string, private isService: boolean) {}
  select(cols = '*') { if (this.op === 'select') { this.cols = cols; if (this.isService) serviceSelects.push({ table: this.table, cols }); } return this; }
  insert(row: Row) { this.op = 'insert'; this.payload = row; return this; }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  eq(c: string, v: unknown) { this.f.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.f.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null) { this.f.push((r) => (r[c] ?? null) === v); return this; }
  neq(c: string, v: unknown) { this.f.push((r) => r[c] !== v); return this; }
  or() { return this; }
  not() { return this; }
  gt() { return this; }
  lt() { return this; }
  gte() { return this; }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { return this.run('maybe'); }
  single() { return this.run('single'); }
  then(resolve: any, reject: any) { return this.run('many').then(resolve, reject); }
  private rows() { return (this.db[this.table] ??= []); }
  private async run(mode: 'many' | 'maybe' | 'single'): Promise<any> {
    if (this.op === 'insert') {
      const stored = { id: `m-${++seq}`, created_at: new Date(Date.UTC(2026, 9, 22, 10, 0, seq)).toISOString(), read_at: null, ...this.payload };
      this.rows().push(stored);
      return { data: stored, error: null };
    }
    let hit = this.rows().filter((r) => this.f.every((x) => x(r)));
    if (this.op === 'update') { hit.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
    if (this.lim != null) hit = hit.slice(0, this.lim);
    const pick = (r: Row) => {
      if (this.cols === '*') return { ...r };
      const out: Row = {};
      for (const c of this.cols.split(',').map((x) => x.trim())) out[c] = r[c];
      return out;
    };
    if (mode === 'many') return { data: hit.map(pick), error: null };
    if (hit.length === 0) return mode === 'single' ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: null, error: null };
    return { data: pick(hit[0]), error: null };
  }
}

const serviceClient = { from: (t: string) => new Q(serviceDb, t, true), rpc: jest.fn() };
const userClientFor = (viewer: string) => ({ from: (t: string) => new Q((userDb[viewer] ??= {}), t, false) });

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => serviceClient) }));
// The bearer token IS the viewer id in these tests.
jest.mock('../src/lib/supabase-user', () => ({ createUserSupabaseClient: jest.fn((token: string) => userClientFor(token)) }));
let caller = ME;
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.identity = { user_id: caller, tenant_id: 'tenant-1', vitana_id: 'me' }; next(); },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));
const mockNotifyUser = jest.fn().mockResolvedValue({ pushed: 1, inapp: true });
jest.mock('../src/services/notification-service', () => ({
  notifyUser: (...a: unknown[]) => mockNotifyUser(...a),
  notifyUserAsync: jest.fn(),
}));
const coalesced: unknown[] = [];
jest.mock('../src/services/chat-push-coalescer', () => ({
  ...jest.requireActual('../src/services/chat-push-coalescer'),
  coalesceChatPushes: async (_sb: unknown, _key: string, items: Array<{ userId: string; payload: unknown }>) => {
    coalesced.push(...items);
    return items.map((i) => ({ userId: i.userId, payload: i.payload }));
  },
}));
jest.mock('../src/services/conversation-client', () => ({ processConversationTurn: jest.fn() }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/system-controls-service', () => ({ isVitanaBrainEnabled: jest.fn().mockResolvedValue(false) }));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
  bulkGetUserLocales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((id) => [id, 'en']))),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatRouter = require('../src/routes/chat').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatGroupsRouter = require('../src/routes/chat-groups').default;
import { parseSharedRef } from '../src/services/chat-shared-content';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/chat/groups', chatGroupsRouter);
  a.use('/chat', chatRouter);
  return a;
}
const as = (viewer: string) => ({ Authorization: `Bearer ${viewer}` });

const postRow = { id: POST, user_id: PEER, content: 'Morning run along the river, join us next week!', image_url: 'https://img/p.jpg', is_public: true };
const hiddenRow = { id: HIDDEN_POST, user_id: ME, content: 'private note', image_url: null, is_public: false };
const eventRow = { id: EVENT, title: 'Yoga in the park', description: 'Bring a mat', image_url: 'https://img/e.jpg', slug: 'yoga-park' };
const productRow = { id: PRODUCT, title: 'Omega-3', description: 'Fish oil', images: ['https://img/o.jpg'], is_active: true };

beforeEach(() => {
  seq = 0;
  caller = ME;
  serviceSelects.length = 0;
  coalesced.length = 0;
  mockNotifyUser.mockClear();
  serviceDb = {
    profile_posts: [postRow, hiddenRow],
    global_community_events: [eventRow],
    products: [productRow],
    global_community_profiles: [
      { user_id: PEER, display_name: 'Peer Person', bio: 'Runner', avatar_url: 'https://img/a.jpg', is_visible: true },
      { user_id: BOT, display_name: 'Test Bot', bio: '', avatar_url: null, is_visible: true },
    ],
    service_bot_accounts: [{ user_id: BOT }],
    notification_test_actors: [],
    chat_messages: [],
    chat_group_members: [{ group_id: GROUP, user_id: ME, role: 'member' }, { group_id: GROUP, user_id: PEER, role: 'member' }],
    chat_groups: [{ id: GROUP, name: 'Runners' }],
    app_users: [{ user_id: ME, display_name: 'Me Myself', email: 'me@x' }],
    profiles: [],
  };
  // ME (the sender) can read the hidden post (their own); PEER cannot.
  userDb = {
    [ME]: {
      profile_posts: [postRow, hiddenRow],
      global_community_events: [eventRow],
      products: [productRow],
      global_community_profiles: serviceDb.global_community_profiles,
    },
    [PEER]: {
      profile_posts: [postRow],
      global_community_events: [eventRow],
      products: [productRow],
      global_community_profiles: serviceDb.global_community_profiles,
    },
  };
});

describe('GET /chat/shared-preview — the card for the caller, with the caller\'s permissions', () => {
  it('a visible post: title (author), description, image and the in-app url', async () => {
    caller = PEER;
    const r = await request(app()).get(`/chat/shared-preview?kind=post&id=${POST}`).set(as(PEER));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true, available: true, kind: 'post', id: POST, title: 'Peer Person',
      description: postRow.content, image_url: 'https://img/p.jpg', url: `/post/post/${POST}`,
    });
  });

  it('event, product and profile cards', async () => {
    const e = await request(app()).get(`/chat/shared-preview?kind=event&id=${EVENT}`).set(as(ME));
    expect(e.body).toMatchObject({ available: true, title: 'Yoga in the park', url: '/e/yoga-park' });
    const p = await request(app()).get(`/chat/shared-preview?kind=product&id=${PRODUCT}`).set(as(ME));
    expect(p.body).toMatchObject({ available: true, title: 'Omega-3', image_url: 'https://img/o.jpg', url: `/discover/product/${PRODUCT}` });
    const u = await request(app()).get(`/chat/shared-preview?kind=profile&id=${PEER}`).set(as(ME));
    expect(u.body).toMatchObject({ available: true, title: 'Peer Person', description: 'Runner', url: `/u/${PEER}` });
  });

  it('a deleted item → { available:false, reason:"deleted" }', async () => {
    const r = await request(app()).get(`/chat/shared-preview?kind=post&id=${GONE}`).set(as(PEER));
    expect(r.body).toEqual({ ok: true, available: false, kind: 'post', id: GONE, reason: 'deleted' });
  });

  it('an item the caller cannot read under RLS → "restricted", even though the sender could', async () => {
    const sender = await request(app()).get(`/chat/shared-preview?kind=post&id=${HIDDEN_POST}`).set(as(ME));
    expect(sender.body.available).toBe(true);
    caller = PEER;
    const viewer = await request(app()).get(`/chat/shared-preview?kind=post&id=${HIDDEN_POST}`).set(as(PEER));
    expect(viewer.body).toEqual({ ok: true, available: false, kind: 'post', id: HIDDEN_POST, reason: 'restricted' });
    expect(JSON.stringify(viewer.body)).not.toContain('private note');
  });

  it('a profile of a service / test account → "restricted"', async () => {
    const r = await request(app()).get(`/chat/shared-preview?kind=profile&id=${BOT}`).set(as(ME));
    expect(r.body).toMatchObject({ available: false, reason: 'restricted' });
    serviceDb.service_bot_accounts = [];
    serviceDb.notification_test_actors = [{ user_id: BOT }];
    const t = await request(app()).get(`/chat/shared-preview?kind=profile&id=${BOT}`).set(as(ME));
    expect(t.body).toMatchObject({ available: false, reason: 'restricted' });
  });

  it('the service-role client never reads item content (only the key, to tell deleted from restricted)', async () => {
    caller = PEER;
    await request(app()).get(`/chat/shared-preview?kind=post&id=${HIDDEN_POST}`).set(as(PEER));
    const itemReads = serviceSelects.filter((s) => ['profile_posts', 'global_community_events', 'products', 'global_community_profiles'].includes(s.table));
    expect(itemReads).toEqual([{ table: 'profile_posts', cols: 'id' }]);
  });

  it('a bad kind or id → 400', async () => {
    expect((await request(app()).get('/chat/shared-preview?kind=video&id=' + POST).set(as(ME))).status).toBe(400);
    expect((await request(app()).get('/chat/shared-preview?kind=post&id=nope').set(as(ME))).status).toBe(400);
  });
});

describe('sending a shared item', () => {
  it('DM: stores only { kind, id } (extra client fields dropped), pushes a catalog line, never the item', async () => {
    const r = await request(app()).post('/chat/send').set(as(ME)).send({
      receiver_id: PEER, message_type: 'shared_content',
      content_data: { kind: 'post', id: POST, title: 'forged title', image_url: 'https://evil/x.jpg' },
    });
    expect(r.status).toBe(201);
    const row = serviceDb.chat_messages.at(-1)!;
    expect(row.message_type).toBe('shared_content');
    expect(row.metadata).toEqual({ kind: 'post', id: POST });
    expect(mockNotifyUser).toHaveBeenCalledTimes(1);
    const payload = mockNotifyUser.mock.calls[0][3];
    expect(payload.body).toBe('Me Myself hat etwas mit dir geteilt');
    expect(JSON.stringify(payload)).not.toContain('Morning run');
    expect(coalesced).toEqual([]); // an event of its own, like an invite
  });

  it('DM: the sender cannot see the item → 403 share_not_allowed, nothing stored', async () => {
    caller = PEER;
    const r = await request(app()).post('/chat/send').set(as(PEER)).send({
      receiver_id: ME, message_type: 'shared_content', content_data: { kind: 'post', id: HIDDEN_POST },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('share_not_allowed');
    expect(serviceDb.chat_messages).toHaveLength(0);
  });

  it('DM: a deleted item, a test-account profile or a bad ref cannot be shared', async () => {
    for (const content_data of [{ kind: 'post', id: GONE }, { kind: 'profile', id: BOT }]) {
      const r = await request(app()).post('/chat/send').set(as(ME)).send({ receiver_id: PEER, message_type: 'shared_content', content_data });
      expect(r.status).toBe(403);
    }
    const bad = await request(app()).post('/chat/send').set(as(ME)).send({ receiver_id: PEER, message_type: 'shared_content', content_data: { kind: 'post' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_shared_content');
    expect(serviceDb.chat_messages).toHaveLength(0);
  });

  it('group: stores only { kind, id } and every member gets the catalog line in their language', async () => {
    const r = await request(app()).post(`/chat/groups/${GROUP}/send`).set(as(ME)).send({
      message_type: 'shared_content', content_data: { kind: 'event', id: EVENT, description: 'forged' },
    });
    expect(r.status).toBe(201);
    expect(serviceDb.chat_messages.at(-1)!.metadata).toEqual({ kind: 'event', id: EVENT });
    expect(mockNotifyUser).toHaveBeenCalledTimes(1);
    expect(mockNotifyUser.mock.calls[0][0]).toBe(PEER);
    expect(mockNotifyUser.mock.calls[0][3].body).toBe('Me Myself shared something with you');
    expect(JSON.stringify(mockNotifyUser.mock.calls[0][3])).not.toContain('Yoga');
  });

  it('group: the sender cannot see the item → 403', async () => {
    caller = PEER;
    const r = await request(app()).post(`/chat/groups/${GROUP}/send`).set(as(PEER)).send({
      message_type: 'shared_content', content_data: { kind: 'post', id: HIDDEN_POST },
    });
    expect(r.status).toBe(403);
    expect(serviceDb.chat_messages).toHaveLength(0);
  });
});

describe('parseSharedRef', () => {
  it('accepts the four kinds with a uuid, nothing else', () => {
    expect(parseSharedRef({ kind: 'product', id: PRODUCT.toUpperCase() })).toEqual({ kind: 'product', id: PRODUCT });
    expect(parseSharedRef({ kind: 'listing', id: PRODUCT })).toBeNull();
    expect(parseSharedRef(null)).toBeNull();
  });
});
