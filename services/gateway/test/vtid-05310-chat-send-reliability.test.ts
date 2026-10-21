/**
 * VTID-05310 (messenger-ux-v2/api-send-reliability) — idempotent chat sends,
 * persisted reply targets, delivered_at and the `around` context window.
 *
 * Contract under test (plan .kiro/specs/messenger-ux-v2/plan.md, I1-I3):
 *   - the same (sender, client_message_id) twice → one row, the second answer is
 *     200 { duplicate: true } with the stored row, and only one push;
 *   - a lost race on the unique index (23505) is answered as the duplicate;
 *   - before the migration (column missing) the send still succeeds without it;
 *   - reply_to_message_id must be a message of the same DM pair / group, stored as
 *     metadata.reply_to = { message_id } only; reads expose reply_to_message_id
 *     only for in-conversation targets (a forged value reads as null);
 *   - POST /delivered only touches rows the caller received; > 200 ids → 400;
 *   - ?around= returns the window ascending with has_older / has_newer and 404s
 *     for a message of another conversation.
 * Runs over an in-memory chat_messages table.
 */

import request from 'supertest';
import express from 'express';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const GROUP2 = '55555555-5555-4555-8555-555555555555';
const CID = '9a6b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

// ── In-memory Supabase ────────────────────────────────────────────────────
type Row = Record<string, any>;
const db: { tables: Record<string, Row[]>; missingColumns: Set<string>; raceOnce: boolean; seq: number } = {
  tables: {},
  missingColumns: new Set(),
  raceOnce: false,
  seq: 0,
};

function getPath(row: Row, col: string) {
  return row[col];
}

function parseOr(expr: string): (r: Row) => boolean {
  // and(a.eq.x,b.eq.y),and(...)  or  a.eq.x,b.eq.y
  const groups = expr.match(/and\(([^)]*)\)/g);
  const parts = groups ? groups.map((g) => g.slice(4, -1)) : expr.split(',').map((p) => p);
  const preds = parts.map((p) => {
    const conds = (groups ? p.split(',') : [p]).map((c) => {
      const [col, op, ...val] = c.split('.');
      const v = val.join('.');
      return (r: Row) => (op === 'eq' ? String(r[col]) === v : false);
    });
    return (r: Row) => conds.every((c) => c(r));
  });
  return (r: Row) => preds.some((p) => p(r));
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private returning = false;
  private countExact = false;
  constructor(private table: string) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select' && opts?.count) this.countExact = true;
    else if (this.op !== 'select') this.returning = true;
    return this;
  }
  insert(row: Row) { this.op = 'insert'; this.payload = row; return this; }
  update(patch: Row, opts?: { count?: string }) { this.op = 'update'; this.payload = patch; this.countExact = !!opts?.count; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => getPath(r, col) === v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(getPath(r, col))); return this; }
  is(col: string, v: null) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
  lt(col: string, v: string) { this.filters.push((r) => r[col] < v); return this; }
  gt(col: string, v: string) { this.filters.push((r) => r[col] > v); return this; }
  gte(col: string, v: string) { this.filters.push((r) => r[col] >= v); return this; }
  or(expr: string) { this.filters.push(parseOr(expr)); return this; }
  not() { return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { return this.run('maybe'); }
  single() { return this.run('single'); }
  then(resolve: any, reject: any) { return this.run('many').then(resolve, reject); }

  private rows() { return (db.tables[this.table] ??= []); }
  private async run(mode: 'many' | 'maybe' | 'single'): Promise<any> {
    if (this.op === 'insert') {
      const row = { ...this.payload! };
      for (const c of Object.keys(row)) {
        if (db.missingColumns.has(c)) {
          return { data: null, error: { code: 'PGRST204', message: `Could not find the '${c}' column of '${this.table}' in the schema cache` } };
        }
      }
      if (row.client_message_id) {
        if (db.raceOnce) {
          db.raceOnce = false;
          this.rows().push({ ...row, id: `race-${++db.seq}`, created_at: new Date(Date.UTC(2026, 9, 21, 9, 0, db.seq)).toISOString() });
        }
        if (this.rows().some((r) => r.sender_id === row.sender_id && r.client_message_id === row.client_message_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_chat_messages_sender_client_message_id"' } };
        }
      }
      const stored = { id: `m-${++db.seq}`, created_at: new Date(Date.UTC(2026, 9, 21, 10, 0, db.seq)).toISOString(), read_at: null, ...row };
      this.rows().push(stored);
      return { data: mode === 'many' && !this.returning ? null : stored, error: null };
    }
    let matched = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') {
      for (const c of Object.keys(this.payload!)) {
        if (db.missingColumns.has(c)) return { data: null, error: { code: '42703', message: `column "${c}" does not exist` }, count: null };
      }
      for (const r of matched) Object.assign(r, this.payload);
      return { data: null, error: null, count: matched.length };
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      matched = [...matched].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.lim != null) matched = matched.slice(0, this.lim);
    if (this.countExact) return { data: null, error: null, count: matched.length };
    if (mode === 'many') return { data: matched.map((r) => ({ ...r })), error: null };
    if (matched.length === 0) return mode === 'single' ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : { data: null, error: null };
    return { data: { ...matched[0] }, error: null };
  }
}
const mockSupabase = { from: (t: string) => new Query(t), rpc: jest.fn() };

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockSupabase) }));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: '11111111-1111-4111-8111-111111111111', tenant_id: 'tenant-1', vitana_id: 'me' };
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));
const mockNotifyUser = jest.fn().mockResolvedValue({ pushed: 1, inapp: true });
jest.mock('../src/services/notification-service', () => ({
  notifyUser: (...a: unknown[]) => mockNotifyUser(...a),
  notifyUserAsync: jest.fn(),
}));
jest.mock('../src/services/chat-push-coalescer', () => ({
  ...jest.requireActual('../src/services/chat-push-coalescer'),
  coalesceChatPushes: async (_sb: unknown, _key: string, items: Array<{ userId: string; payload: unknown }>) =>
    items.map((i) => ({ userId: i.userId, payload: i.payload })),
}));
jest.mock('../src/services/conversation-client', () => ({ processConversationTurn: jest.fn() }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/system-controls-service', () => ({ isVitanaBrainEnabled: jest.fn().mockResolvedValue(false) }));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('en'),
  bulkGetUserLocales: jest.fn().mockResolvedValue(new Map()),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatRouter = require('../src/routes/chat').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatGroupsRouter = require('../src/routes/chat-groups').default;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/chat/groups', chatGroupsRouter);
  a.use('/chat', chatRouter);
  return a;
}

function seed(rows: Row[]) {
  for (const r of rows) {
    db.tables.chat_messages.push({ tenant_id: 'tenant-1', receiver_id: null, group_id: null, read_at: null, metadata: {}, message_type: 'text', ...r });
  }
}
const dmRows = () => db.tables.chat_messages.filter((r) => !r.group_id);

beforeEach(() => {
  db.tables = {
    chat_messages: [],
    chat_group_members: [
      { group_id: GROUP, user_id: ME, role: 'member' },
      { group_id: GROUP, user_id: PEER, role: 'member' },
      { group_id: GROUP2, user_id: ME, role: 'member' },
    ],
    chat_groups: [{ id: GROUP, name: 'G' }, { id: GROUP2, name: 'G2' }],
  };
  db.missingColumns = new Set();
  db.raceOnce = false;
  db.seq = 0;
  mockNotifyUser.mockClear();
});

describe('POST /chat/send — client_message_id (I1)', () => {
  it('a repeat of the same client_message_id stores one row, answers 200 duplicate and pushes once', async () => {
    const first = await request(app()).post('/chat/send').send({ receiver_id: PEER, content: 'hi', client_message_id: CID });
    expect(first.status).toBe(201);
    expect(first.body.data.client_message_id).toBe(CID);
    const second = await request(app()).post('/chat/send').send({ receiver_id: PEER, content: 'hi', client_message_id: CID });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, duplicate: true, data: { id: first.body.data.id } });
    expect(dmRows()).toHaveLength(1);
    expect(mockNotifyUser).toHaveBeenCalledTimes(1);
  });

  it('a lost race on the unique index (23505) is answered as the duplicate, not a 500', async () => {
    db.raceOnce = true;
    const res = await request(app()).post('/chat/send').send({ receiver_id: PEER, content: 'hi', client_message_id: CID });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(dmRows()).toHaveLength(1);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it('without the migration the send still succeeds (column missing → retried without it)', async () => {
    db.missingColumns.add('client_message_id');
    const res = await request(app()).post('/chat/send').send({ receiver_id: PEER, content: 'hi', client_message_id: CID });
    expect(res.status).toBe(201);
    expect(dmRows()).toHaveLength(1);
    expect(dmRows()[0].client_message_id).toBeUndefined();
  });

  it('rejects a malformed client_message_id', async () => {
    const res = await request(app()).post('/chat/send').send({ receiver_id: PEER, content: 'hi', client_message_id: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_message_id');
    expect(dmRows()).toHaveLength(0);
  });
});

describe('review findings (I1)', () => {
  it('a client_message_id reused for another conversation is 409, never a silent duplicate', async () => {
    await request(app()).post('/chat/send').send({ receiver_id: PEER, content: 'to peer', client_message_id: CID });
    const other = await request(app()).post('/chat/send').send({ receiver_id: OTHER, content: 'to other', client_message_id: CID });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('client_message_id_conflict');
    const group = await request(app()).post(`/chat/groups/${GROUP}/send`).send({ content: 'to group', client_message_id: CID });
    expect(group.status).toBe(409);
    expect(db.tables.chat_messages).toHaveLength(1);
  });

  it('a reply target smuggled in content_data is dropped (only reply_to_message_id is validated and stored)', async () => {
    seed([{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sender_id: OTHER, receiver_id: ME, content: 'elsewhere', created_at: '2026-10-21T07:00:00.000Z' }]);
    const res = await request(app()).post('/chat/send')
      .send({ receiver_id: PEER, content: 'hi', content_data: { reply_to: { message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } } });
    expect(res.status).toBe(201);
    expect(res.body.data.reply_to_message_id).toBeNull();
    expect(dmRows().find((r) => r.content === 'hi')!.metadata.reply_to).toBeUndefined();
    const g = await request(app()).post(`/chat/groups/${GROUP}/send`)
      .send({ content: 'g', content_data: { reply_to: { message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } } });
    expect(g.body.data.reply_to_message_id).toBeNull();
  });

  it('a group duplicate answers with the stored reply target and never triggers the @vitana reply again', async () => {
    seed([{ id: '19191919-1919-4191-8191-191919191919', sender_id: PEER, group_id: GROUP, content: 'q', created_at: '2026-10-21T08:00:00.000Z' }]);
    const { processConversationTurn } = jest.requireMock('../src/services/conversation-client') as { processConversationTurn: jest.Mock };
    const first = await request(app()).post(`/chat/groups/${GROUP}/send`)
      .send({ content: 'hey @vitana', client_message_id: CID, reply_to_message_id: '19191919-1919-4191-8191-191919191919' });
    expect(first.status).toBe(201);
    processConversationTurn.mockClear();
    const again = await request(app()).post(`/chat/groups/${GROUP}/send`)
      .send({ content: 'hey @vitana', client_message_id: CID });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.data.reply_to_message_id).toBe('19191919-1919-4191-8191-191919191919');
    await new Promise((r) => setTimeout(r, 20));
    expect(processConversationTurn).not.toHaveBeenCalled();
  });
});

describe('replies (I1)', () => {
  it('a reply to a message of the same DM pair stores metadata.reply_to = { message_id } only', async () => {
    seed([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sender_id: PEER, receiver_id: ME, content: 'parent', created_at: '2026-10-21T08:00:00.000Z' }]);
    const res = await request(app()).post('/chat/send')
      .send({ receiver_id: PEER, content: 'answer', reply_to_message_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(res.status).toBe(201);
    expect(res.body.data.reply_to_message_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const stored = dmRows().find((r) => r.content === 'answer')!;
    expect(stored.metadata.reply_to).toEqual({ message_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  });

  it.each([
    ['another DM pair', { sender_id: OTHER, receiver_id: ME }],
    ['a group', { sender_id: PEER, receiver_id: null, group_id: GROUP }],
  ])('a reply target in %s is refused with 400 invalid_reply_target', async (_l, where) => {
    seed([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', content: 'elsewhere', created_at: '2026-10-21T08:00:00.000Z', ...where }]);
    const res = await request(app()).post('/chat/send')
      .send({ receiver_id: PEER, content: 'answer', reply_to_message_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_reply_target');
  });

  it('an unknown reply target is refused', async () => {
    const res = await request(app()).post('/chat/send')
      .send({ receiver_id: PEER, content: 'answer', reply_to_message_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_reply_target');
  });

  it('reads expose reply_to_message_id only for in-conversation targets (a forged one reads as null)', async () => {
    seed([
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sender_id: OTHER, receiver_id: PEER, content: 'private', created_at: '2026-10-21T07:00:00.000Z' },
      { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sender_id: PEER, receiver_id: ME, content: 'parent', created_at: '2026-10-21T08:00:00.000Z' },
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sender_id: PEER, receiver_id: ME, content: 'forged', created_at: '2026-10-21T09:00:00.000Z',
        metadata: { reply_to: { message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } } },
      { id: '12121212-1212-4121-8121-121212121212', sender_id: ME, receiver_id: PEER, content: 'real', created_at: '2026-10-21T09:30:00.000Z',
        metadata: { reply_to: { message_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } } },
    ]);
    const res = await request(app()).get(`/chat/conversation/${PEER}`);
    expect(res.status).toBe(200);
    const byContent = Object.fromEntries(res.body.data.map((r: Row) => [r.content, r.reply_to_message_id]));
    expect(byContent.forged).toBeNull();
    expect(byContent.real).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(byContent.private).toBeUndefined(); // not this conversation at all
  });
});

describe('POST /chat/delivered and /chat/read (I2)', () => {
  it('marks only messages the caller received', async () => {
    seed([
      { id: '13131313-1313-4131-8131-131313131313', sender_id: PEER, receiver_id: ME, content: 'to me', created_at: '2026-10-21T08:00:00.000Z' },
      { id: '14141414-1414-4141-8141-141414141414', sender_id: ME, receiver_id: PEER, content: 'from me', created_at: '2026-10-21T08:01:00.000Z' },
      { id: '15151515-1515-4151-8151-151515151515', sender_id: PEER, receiver_id: OTHER, content: 'not mine', created_at: '2026-10-21T08:02:00.000Z' },
    ]);
    const res = await request(app()).post('/chat/delivered')
      .send({ message_ids: ['13131313-1313-4131-8131-131313131313', '14141414-1414-4141-8141-141414141414', '15151515-1515-4151-8151-151515151515'] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const at = Object.fromEntries(dmRows().map((r) => [r.content, r.delivered_at ?? null]));
    expect(at['to me']).toEqual(expect.any(String));
    expect(at['from me']).toBeNull();
    expect(at['not mine']).toBeNull();
  });

  it('refuses more than 200 ids, an empty list and malformed ids', async () => {
    const many = Array.from({ length: 201 }, () => CID);
    expect((await request(app()).post('/chat/delivered').send({ message_ids: many })).status).toBe(400);
    expect((await request(app()).post('/chat/delivered').send({ message_ids: [] })).status).toBe(400);
    expect((await request(app()).post('/chat/delivered').send({ message_ids: ['x'] })).status).toBe(400);
  });

  it('answers updated: 0 before the migration', async () => {
    db.missingColumns.add('delivered_at');
    const res = await request(app()).post('/chat/delivered').send({ message_ids: [CID] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  it('/chat/read also fills a NULL delivered_at', async () => {
    seed([{ id: '16161616-1616-4161-8161-161616161616', sender_id: PEER, receiver_id: ME, content: 'x', created_at: '2026-10-21T08:00:00.000Z' }]);
    const res = await request(app()).post('/chat/read').send({ peer_id: PEER });
    expect(res.status).toBe(200);
    expect(dmRows()[0].read_at).toEqual(expect.any(String));
    expect(dmRows()[0].delivered_at).toEqual(expect.any(String));
  });
});

describe('GET ?around= (I3)', () => {
  function seedThread(n: number) {
    seed(Array.from({ length: n }, (_, i) => ({
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      sender_id: i % 2 ? PEER : ME,
      receiver_id: i % 2 ? ME : PEER,
      content: `m${i}`,
      created_at: new Date(Date.UTC(2026, 9, 20, 0, i)).toISOString(),
    })));
  }

  it('returns the window ascending around the target with has_older / has_newer', async () => {
    seedThread(30);
    const target = 'aaaaaaaa-0000-4000-8000-000000000015';
    const res = await request(app()).get(`/chat/conversation/${PEER}?around=${target}&limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: Row) => r.content)).toEqual(['m10', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16', 'm17', 'm18', 'm19', 'm20']);
    expect(res.body.has_older).toBe(true);
    expect(res.body.has_newer).toBe(true);
  });

  it('at the newest message there is nothing newer', async () => {
    seedThread(6);
    const res = await request(app()).get(`/chat/conversation/${PEER}?around=aaaaaaaa-0000-4000-8000-000000000005&limit=10`);
    expect(res.body.data.map((r: Row) => r.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(res.body.has_older).toBe(false);
    expect(res.body.has_newer).toBe(false);
  });

  it('a message of another conversation is 404', async () => {
    seed([{ id: '17171717-1717-4171-8171-171717171717', sender_id: OTHER, receiver_id: ME, content: 'x', created_at: '2026-10-21T08:00:00.000Z' }]);
    const res = await request(app()).get(`/chat/conversation/${PEER}?around=17171717-1717-4171-8171-171717171717`);
    expect(res.status).toBe(404);
  });

  it('?after= pages forward, ascending', async () => {
    seedThread(5);
    const res = await request(app()).get(`/chat/conversation/${PEER}?after=${new Date(Date.UTC(2026, 9, 20, 0, 2)).toISOString()}`);
    expect(res.body.data.map((r: Row) => r.content)).toEqual(['m3', 'm4']);
  });

  it('a non-uuid peer id is refused (it is interpolated into the filter)', async () => {
    const res = await request(app()).get('/chat/conversation/x),or(id.neq.0');
    expect(res.status).toBe(400);
  });
});

describe('groups (I1, I3)', () => {
  it('a repeated group send stores one row, answers duplicate and fans out once', async () => {
    const first = await request(app()).post(`/chat/groups/${GROUP}/send`).send({ content: 'hi all', client_message_id: CID });
    expect(first.status).toBe(201);
    const fanout = mockNotifyUser.mock.calls.length;
    expect(fanout).toBeGreaterThan(0);
    const second = await request(app()).post(`/chat/groups/${GROUP}/send`).send({ content: 'hi all', client_message_id: CID });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(db.tables.chat_messages.filter((r) => r.group_id === GROUP)).toHaveLength(1);
    expect(mockNotifyUser.mock.calls.length).toBe(fanout);
  });

  it('a reply target in another group is refused', async () => {
    seed([{ id: '18181818-1818-4181-8181-181818181818', sender_id: ME, group_id: GROUP2, content: 'g2', created_at: '2026-10-21T08:00:00.000Z' }]);
    const res = await request(app()).post(`/chat/groups/${GROUP}/send`)
      .send({ content: 'answer', reply_to_message_id: '18181818-1818-4181-8181-181818181818' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_reply_target');
  });

  it('a reply inside the group is stored and returned', async () => {
    seed([{ id: '19191919-1919-4191-8191-191919191919', sender_id: PEER, group_id: GROUP, content: 'q', created_at: '2026-10-21T08:00:00.000Z' }]);
    const res = await request(app()).post(`/chat/groups/${GROUP}/send`)
      .send({ content: 'a', reply_to_message_id: '19191919-1919-4191-8191-191919191919' });
    expect(res.status).toBe(201);
    expect(res.body.data.reply_to_message_id).toBe('19191919-1919-4191-8191-191919191919');
  });

  it('?around= on a message of another group is 404', async () => {
    seed([{ id: '20202020-2020-4202-8202-202020202020', sender_id: ME, group_id: GROUP2, content: 'g2', created_at: '2026-10-21T08:00:00.000Z' }]);
    const res = await request(app()).get(`/chat/groups/${GROUP}/messages?around=20202020-2020-4202-8202-202020202020`);
    expect(res.status).toBe(404);
  });
});
