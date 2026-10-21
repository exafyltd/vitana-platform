/**
 * VTID-05104 — calendar invites, phase 1: guards and fixes.
 *
 *   - checkInviteSend: test/service accounts (both directions), tenant,
 *     relationship (a)(b)(c), the daily and pair-week quotas, the group cap,
 *     fail-closed lookups, one generic refusal;
 *   - POST /chat/send and POST /chat/groups/:id/send with calendar_invite
 *     (refusals insert nothing, the push is generic, other types unchanged);
 *   - the voice tool stores a v2 card that inviteMetadataOf accepts, refuses
 *     private / past / recurring entries, keeps its quota and sends a generic push.
 * In-memory only: no network, no database.
 */
import request from 'supertest';
import express from 'express';

// ── in-memory stand-in for the supabase client ───────────────────────────────
type Row = Record<string, any>;
const db: { tables: Record<string, Row[]>; failTables: Set<string> } = { tables: {}, failTables: new Set() };
let seq = 0;

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let limitN = Infinity;
  let inserted: Row[] | null = null;
  const run = () => {
    if (db.failTables.has(table)) return { data: null, error: { message: `${table} down` } };
    const all = db.tables[table] ?? [];
    const matched = inserted ?? all.filter((r) => filters.every((f) => f(r))).slice(0, limitN);
    return { data: matched.map((r) => ({ ...r })), error: null };
  };
  const b: any = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: any) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: any) => (filters.push((r) => r[c] !== v), b),
    in: (c: string, vs: any[]) => (filters.push((r) => vs.includes(r[c])), b),
    gte: (c: string, v: any) => (filters.push((r) => r[c] >= v), b),
    limit: (n: number) => ((limitN = n), b),
    insert: (row: Row) => {
      if (db.failTables.has(table)) return Object.assign(b, { _fail: true });
      const stored = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, created_at: new Date().toISOString(), ...row };
      (db.tables[table] ??= []).push(stored);
      inserted = [stored];
      return b;
    },
    maybeSingle: () => Promise.resolve((() => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }; })()),
    single: () => b.maybeSingle(),
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}
const fakeSb: any = { from: (t: string) => builder(t) };
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => fakeSb) }));

// ── collaborators ────────────────────────────────────────────────────────────
const mockNotifyUser = jest.fn().mockResolvedValue({ pushed: true });
const mockNotifyAsync = jest.fn();
jest.mock('../src/services/notification-service', () => ({
  notifyUser: (...a: unknown[]) => mockNotifyUser(...a),
  notifyUserAsync: (...a: unknown[]) => mockNotifyAsync(...a),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/conversation-client', () => ({ processConversationTurn: jest.fn() }));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
  bulkGetUserLocales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((i) => [i, 'en']))),
}));

const SENDER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT_USER = '44444444-4444-4444-8444-444444444444';
const BOT_ACCOUNT = '55555555-5555-4555-8555-555555555555';
const TEST_ACTOR = '66666666-6666-4666-8666-666666666666';
const ENTRY = '77777777-7777-4777-8777-777777777777';
const TENANT = 'tenant-1';
const GROUP = 'g1';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer ok') return res.status(401).json({ ok: false, error: 'unauthorized' });
    req.identity = { user_id: '11111111-1111-4111-8111-111111111111', tenant_id: 'tenant-1', vitana_id: 'me' };
    return next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));

const mockGetOwnEvent = jest.fn();
jest.mock('../src/services/calendar-service', () => ({
  ...jest.requireActual('../src/services/calendar-service'),
  getOwnCalendarEvent: (...a: unknown[]) => mockGetOwnEvent(...a),
}));

import {
  checkInviteSend,
  inviteLimits,
  evaluateInviteQuota,
  groupAllowsInvite,
  involvesExcludedAccount,
  INVITE_REFUSED_CODE,
} from '../src/services/calendar-invite-guard';
import { inviteMetadataOf } from '../src/services/calendar-invite';
import { tt } from '../src/i18n/catalog';
import chatRouter from '../src/routes/chat';
import chatGroupsRouter from '../src/routes/chat-groups';
import { tool_send_calendar_invite_in_chat } from '../src/services/orb-tools/messaging-depth-tools';
import { _resetSendCountersForTests } from '../src/services/voice-message-guard';

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function seed(opts: { relationship?: 'dm' | 'dm_reverse' | 'group' | 'follow' | 'follow_reverse' | 'none' } = {}) {
  db.failTables.clear();
  db.tables = {
    app_users: [
      { user_id: SENDER, tenant_id: TENANT, display_name: 'Anna', email: 'anna@x.test', vitana_id: 'anna1' },
      { user_id: FRIEND, tenant_id: TENANT, display_name: 'Ben', email: 'ben@x.test', vitana_id: 'ben1' },
      { user_id: STRANGER, tenant_id: TENANT, display_name: 'Cy', email: 'cy@x.test', vitana_id: 'cy1' },
      { user_id: OTHER_TENANT_USER, tenant_id: 'tenant-2', display_name: 'Di', email: 'di@x.test', vitana_id: 'di1' },
      { user_id: BOT_ACCOUNT, tenant_id: TENANT, display_name: 'Bot', email: 'bot@x.test', vitana_id: 'bot1' },
      { user_id: TEST_ACTOR, tenant_id: TENANT, display_name: 'Tst', email: 'tst@x.test', vitana_id: 'tst1' },
    ],
    service_bot_accounts: [{ user_id: BOT_ACCOUNT }],
    notification_test_actors: [{ user_id: TEST_ACTOR }],
    chat_messages: [],
    chat_group_members: [],
    chat_groups: [{ id: GROUP, name: 'Walkers', tenant_id: TENANT }],
    user_follows: [],
    profiles: [],
    calendar_events: [],
  };
  const rel = opts.relationship ?? 'dm';
  const peer = FRIEND;
  if (rel === 'dm') db.tables.chat_messages.push({ id: 'm0', tenant_id: TENANT, sender_id: SENDER, receiver_id: peer, message_type: 'text', created_at: iso(-30 * 24 * HOUR) });
  if (rel === 'dm_reverse') db.tables.chat_messages.push({ id: 'm0', tenant_id: TENANT, sender_id: peer, receiver_id: SENDER, message_type: 'text', created_at: iso(-30 * 24 * HOUR) });
  if (rel === 'group') db.tables.chat_group_members.push({ group_id: 'shared', user_id: SENDER }, { group_id: 'shared', user_id: peer }, { group_id: 'other', user_id: SENDER });
  if (rel === 'follow') db.tables.user_follows.push({ id: 'f1', follower_id: SENDER, following_id: peer });
  if (rel === 'follow_reverse') db.tables.user_follows.push({ id: 'f1', follower_id: peer, following_id: SENDER });
  mockNotifyUser.mockClear();
  mockNotifyAsync.mockClear();
  mockGetOwnEvent.mockReset();
}

const guard = (over: Record<string, unknown> = {}) =>
  checkInviteSend({ sb: fakeSb, senderId: SENDER, tenantId: TENANT, receiverId: FRIEND, ...over } as any);

function addInvites(n: number, receiver: string | null, ageMs: number) {
  for (let i = 0; i < n; i++) {
    db.tables.chat_messages.push({ id: `inv${seq++}`, tenant_id: TENANT, sender_id: SENDER, receiver_id: receiver, message_type: 'calendar_invite', created_at: iso(-ageMs) });
  }
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://db.test';
  process.env.SUPABASE_SERVICE_ROLE = 'service-key';
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  seed();
});
afterEach(() => jest.restoreAllMocks());

// ═══ pure helpers ════════════════════════════════════════════════════════════
describe('limits and pure helpers', () => {
  it('defaults 30 / 5 / 20 and is overridable by env; bad values fall back', () => {
    expect(inviteLimits({})).toEqual({ maxPerDay: 30, maxPerPairWeek: 5, maxGroupMembers: 20 });
    expect(inviteLimits({ CALENDAR_INVITE_MAX_PER_DAY: '3', CALENDAR_INVITE_MAX_PER_PAIR_WEEK: '2', CALENDAR_INVITE_MAX_GROUP_MEMBERS: '4' } as any))
      .toEqual({ maxPerDay: 3, maxPerPairWeek: 2, maxGroupMembers: 4 });
    expect(inviteLimits({ CALENDAR_INVITE_MAX_PER_DAY: 'x', CALENDAR_INVITE_MAX_PER_PAIR_WEEK: '0' } as any)).toMatchObject({ maxPerDay: 30, maxPerPairWeek: 5 });
  });

  it('evaluateInviteQuota windows: 24h and 7d', () => {
    const now = new Date();
    const lim = inviteLimits({});
    const rows = (n: number, recv: string, ageH: number) => Array.from({ length: n }, () => ({ receiver_id: recv, created_at: iso(-ageH * HOUR) }));
    expect(evaluateInviteQuota(rows(29, 'a', 1), 'b', now, lim).allowed).toBe(true);
    expect(evaluateInviteQuota(rows(30, 'a', 1), 'b', now, lim)).toEqual({ allowed: false, reason: 'daily_limit' });
    expect(evaluateInviteQuota(rows(30, 'a', 25), 'b', now, lim).allowed).toBe(true); // older than a day
    expect(evaluateInviteQuota(rows(5, 'b', 48), 'b', now, lim)).toEqual({ allowed: false, reason: 'pair_week_limit' });
    expect(evaluateInviteQuota(rows(5, 'b', 24 * 8), 'b', now, lim).allowed).toBe(true); // older than a week
    expect(evaluateInviteQuota(rows(5, 'b', 48), 'c', now, lim).allowed).toBe(true); // other pair
    expect(evaluateInviteQuota(rows(5, 'b', 48), null, now, lim).allowed).toBe(true); // group send: no pair
  });

  it('groupAllowsInvite and involvesExcludedAccount', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
    expect(groupAllowsInvite(ids(20), 'u0', 20)).toBe(true);
    expect(groupAllowsInvite(ids(21), 'u0', 20)).toBe(false);
    expect(groupAllowsInvite(ids(3), 'nobody', 20)).toBe(false);
    expect(involvesExcludedAccount(new Set(['x']), 'a', 'x')).toBe(true);
    expect(involvesExcludedAccount(new Set(['x']), 'a', null)).toBe(false);
  });
});

// ═══ checkInviteSend ═════════════════════════════════════════════════════════
describe('checkInviteSend — direct invites', () => {
  it('allows a related, in-tenant, unlimited invite', async () => {
    expect(await guard()).toEqual({ ok: true });
  });

  it('refuses a test/service account as sender and as receiver (both allowlists)', async () => {
    for (const bad of [BOT_ACCOUNT, TEST_ACTOR]) {
      db.tables.chat_messages.push({ id: `p${bad}`, tenant_id: TENANT, sender_id: SENDER, receiver_id: bad, message_type: 'text', created_at: iso(-HOUR) });
      expect(await guard({ receiverId: bad })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
      expect(await guard({ senderId: bad, receiverId: FRIEND })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    }
    expect(await guard({ groupId: GROUP, receiverId: undefined, senderId: TEST_ACTOR })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('refuses a receiver in another tenant, an unknown receiver, a missing tenant, yourself and the Vitana bot', async () => {
    db.tables.user_follows.push({ id: 'f9', follower_id: SENDER, following_id: OTHER_TENANT_USER });
    expect(await guard({ receiverId: OTHER_TENANT_USER })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    expect(await guard({ receiverId: '99999999-9999-4999-8999-999999999999' })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    expect(await guard({ tenantId: null })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    expect(await guard({ receiverId: SENDER })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    expect(await guard({ receiverId: '00000000-0000-0000-0000-000000000001' })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('refuses with no relationship', async () => {
    seed({ relationship: 'none' });
    expect(await guard({ receiverId: STRANGER })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it.each(['dm', 'dm_reverse', 'group', 'follow', 'follow_reverse'] as const)('relationship via %s is enough', async (rel) => {
    seed({ relationship: rel });
    expect(await guard()).toEqual({ ok: true });
  });

  it('a prior invite alone is not a relationship', async () => {
    seed({ relationship: 'none' });
    db.tables.chat_messages.push({ id: 'i0', tenant_id: TENANT, sender_id: SENDER, receiver_id: FRIEND, message_type: 'calendar_invite', created_at: iso(-HOUR) });
    expect(await guard()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('a group the sender is in without the receiver is not a relationship', async () => {
    seed({ relationship: 'none' });
    db.tables.chat_group_members.push({ group_id: 'solo', user_id: SENDER }, { group_id: 'solo', user_id: STRANGER });
    expect(await guard()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('the 31st invite in a day is refused, the 30th is allowed', async () => {
    addInvites(29, STRANGER, HOUR);
    expect(await guard()).toEqual({ ok: true });
    addInvites(1, STRANGER, HOUR);
    expect(await guard()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('the 6th invite to one person in a week is refused, the 5th is allowed', async () => {
    addInvites(4, FRIEND, 2 * 24 * HOUR);
    expect(await guard()).toEqual({ ok: true });
    addInvites(1, FRIEND, 2 * 24 * HOUR);
    expect(await guard()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    expect(await guard({ receiverId: FRIEND, env: { CALENDAR_INVITE_MAX_PER_PAIR_WEEK: '9' } as any })).toEqual({ ok: true });
  });

  it('refusals are the same for every rule: one code, one shape, no reason in the result', async () => {
    const results: any[] = [];
    results.push(await guard({ receiverId: BOT_ACCOUNT }));
    results.push(await guard({ receiverId: OTHER_TENANT_USER }));
    results.push(await guard({ receiverId: STRANGER })); // no relationship
    addInvites(30, STRANGER, HOUR);
    results.push(await guard());
    for (const r of results) expect(r).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});

describe('checkInviteSend — group invites', () => {
  const members = (n: number, withSender = true) => {
    db.tables.chat_group_members = Array.from({ length: n }, (_, i) => ({ group_id: GROUP, user_id: i === 0 && withSender ? SENDER : `m${i}` }));
  };
  const g = (over: Record<string, unknown> = {}) => guard({ receiverId: undefined, groupId: GROUP, ...over });

  it('allows a member of a group of 20, refuses 21, refuses a non-member', async () => {
    members(20);
    expect(await g()).toEqual({ ok: true });
    members(21);
    expect(await g()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    members(5, false);
    expect(await g()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('the group cap is env-adjustable and a group invite counts against the daily quota', async () => {
    members(10);
    expect(await g({ env: { CALENDAR_INVITE_MAX_GROUP_MEMBERS: '9' } })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    addInvites(30, null, HOUR); // 30 earlier group invites
    expect(await g()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('refuses both a receiver and a group, or neither', async () => {
    members(3);
    expect(await guard({ groupId: GROUP })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    expect(await guard({ receiverId: undefined })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });
});

describe('checkInviteSend — fails closed', () => {
  it.each(['service_bot_accounts', 'notification_test_actors', 'app_users', 'user_follows', 'chat_group_members'])(
    'a %s lookup error refuses with the generic code',
    async (table) => {
      seed({ relationship: 'follow' });
      db.tables.chat_group_members.push({ group_id: GROUP, user_id: SENDER });
      db.failTables.add(table);
      expect(await guard()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    },
  );

  it('a chat_messages lookup error refuses (relationship (a) and quota)', async () => {
    db.failTables.add('chat_messages');
    expect(await guard()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
    seed({ relationship: 'follow' }); // relationship by follow, so only the quota read touches chat_messages
    db.failTables.add('chat_messages');
    expect(await guard()).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('a thrown error refuses', async () => {
    const boom: any = { from: () => { throw new Error('boom'); } };
    expect(await checkInviteSend({ sb: boom, senderId: SENDER, tenantId: TENANT, receiverId: FRIEND })).toEqual({ ok: false, code: INVITE_REFUSED_CODE });
  });

  it('the quota read carries tenant_id, sender_id and a bounded created_at window', async () => {
    const seen: string[] = [];
    const spy: any = {
      from: (t: string) => {
        const b = fakeSb.from(t);
        if (t === 'chat_messages') {
          for (const m of ['eq', 'gte']) { const o = b[m]; b[m] = (c: string, v: any) => (seen.push(`${m}:${c}`), o(c, v)); }
        }
        return b;
      },
    };
    await checkInviteSend({ sb: spy, senderId: SENDER, tenantId: TENANT, receiverId: FRIEND });
    expect(seen).toEqual(expect.arrayContaining(['eq:tenant_id', 'eq:sender_id', 'gte:created_at']));
  });
});

// ═══ routes ══════════════════════════════════════════════════════════════════
function app() {
  const a = express();
  a.use(express.json());
  a.use('/chat/groups', chatGroupsRouter);
  a.use('/chat', chatRouter);
  return a;
}
const invites = () => db.tables.chat_messages.filter((m) => m.message_type === 'calendar_invite');
const ownEntry = (over: Row = {}) => ({
  id: ENTRY, user_id: SENDER, title: 'Coffee at Luigi', status: 'confirmed', source_type: 'manual',
  start_time: iso(48 * HOUR), end_time: iso(49 * HOUR), location: 'Luigi', rrule: null, ...over,
});

describe('POST /chat/send with calendar_invite', () => {
  const send = (body: Record<string, unknown>) => request(app()).post('/chat/send').set('Authorization', 'Bearer ok').send(body);

  it('allowed: inserts the server-built card and pushes a generic body (no title, time or place)', async () => {
    mockGetOwnEvent.mockResolvedValue(ownEntry());
    const res = await send({ receiver_id: FRIEND, message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(res.status).toBe(201);
    expect(invites()).toHaveLength(1);
    expect(invites()[0].content).toBe('📅 Coffee at Luigi');
    expect(mockNotifyUser).toHaveBeenCalledTimes(1);
    const payload = mockNotifyUser.mock.calls[0][3];
    expect(payload.body).toBe(tt('notif.calendar_invite.body', 'de', { name: 'Anna' }));
    expect(payload.body).not.toMatch(/Coffee|Luigi|📅/);
  });

  it.each([
    ['a test account receiver', () => ({ receiver_id: BOT_ACCOUNT })],
    ['another tenant', () => ({ receiver_id: OTHER_TENANT_USER })],
    ['no relationship', () => ({ receiver_id: STRANGER })],
  ])('refused (%s): generic 403, nothing inserted, no push', async (_n, body) => {
    mockGetOwnEvent.mockResolvedValue(ownEntry());
    const res = await send({ ...body(), message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: INVITE_REFUSED_CODE });
    expect(invites()).toHaveLength(0);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it('refused over the daily limit with the very same body', async () => {
    mockGetOwnEvent.mockResolvedValue(ownEntry());
    addInvites(30, STRANGER, HOUR);
    const before = invites().length;
    const res = await send({ receiver_id: FRIEND, message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: INVITE_REFUSED_CODE });
    expect(invites()).toHaveLength(before);
  });

  it('non-invite messages do not go through the guard', async () => {
    seed({ relationship: 'none' });
    db.failTables.add('notification_test_actors'); // would refuse every invite
    const res = await send({ receiver_id: STRANGER, content: 'hi' });
    expect(res.status).toBe(201);
    expect(db.tables.chat_messages.at(-1)).toMatchObject({ message_type: 'text', content: 'hi' });
    expect(mockNotifyUser.mock.calls[0][3].body).toBe('hi');
  });
});

describe('POST /chat/groups/:id/send with calendar_invite', () => {
  const send = (body: Record<string, unknown>) => request(app()).post(`/chat/groups/${GROUP}/send`).set('Authorization', 'Bearer ok').send(body);
  const members = (n: number) => {
    db.tables.chat_group_members = Array.from({ length: n }, (_, i) => ({ group_id: GROUP, user_id: i === 0 ? SENDER : i === 1 ? FRIEND : `m${i}`, role: 'member' }));
  };

  it('allowed in a group of 20: inserts the card, each member gets the generic push in their locale', async () => {
    mockGetOwnEvent.mockResolvedValue(ownEntry());
    members(20);
    const res = await send({ message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(res.status).toBe(201);
    expect(invites()).toHaveLength(1);
    expect(invites()[0]).toMatchObject({ group_id: GROUP, content: '📅 Coffee at Luigi' });
    expect(mockNotifyUser).toHaveBeenCalledTimes(19);
    for (const call of mockNotifyUser.mock.calls) {
      expect(call[3].body).toBe(tt('notif.calendar_invite.body', 'en', { name: 'Anna' }));
      expect(call[3].body).not.toMatch(/Coffee|Luigi/);
    }
  });

  it('refused in a group of 21: generic 403, nothing inserted, no push', async () => {
    mockGetOwnEvent.mockResolvedValue(ownEntry());
    members(21);
    const res = await send({ message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: INVITE_REFUSED_CODE });
    expect(invites()).toHaveLength(0);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it('refused for a test-account sender and over the daily limit', async () => {
    mockGetOwnEvent.mockResolvedValue(ownEntry());
    members(3);
    addInvites(30, null, HOUR);
    const before = invites().length;
    const res = await send({ message_type: 'calendar_invite', content_data: { entry_id: ENTRY } });
    expect(res.status).toBe(403);
    expect(invites()).toHaveLength(before);
    db.tables.notification_test_actors.push({ user_id: SENDER });
    db.tables.chat_messages = [];
    expect((await send({ message_type: 'calendar_invite', content_data: { entry_id: ENTRY } })).status).toBe(403);
  });

  it('a non-member still gets not_a_member; text messages are unaffected and keep their push', async () => {
    mockGetOwnEvent.mockResolvedValue(ownEntry());
    members(3);
    db.tables.chat_group_members = db.tables.chat_group_members.filter((m) => m.user_id !== SENDER);
    expect((await send({ message_type: 'calendar_invite', content_data: { entry_id: ENTRY } })).status).toBe(403);
    members(3);
    const res = await send({ content: 'hello all' });
    expect(res.status).toBe(201);
    expect(mockNotifyUser.mock.calls[0][3].body).toBe('Anna: hello all');
  });
});

// ═══ voice tool ══════════════════════════════════════════════════════════════
describe('voice tool send_calendar_invite_in_chat', () => {
  const ID: any = { user_id: SENDER, tenant_id: TENANT, role: 'community', vitana_id: 'anna1' };
  // The voice send quota is a module-level counter: each test starts from zero.
  beforeEach(() => _resetSendCountersForTests());
  // VTID-05126: a confirmed send carries the card_token of the preview the member approved.
  const preview = (over: Record<string, unknown> = {}) =>
    tool_send_calendar_invite_in_chat({ event_id: ENTRY, member_user_id: FRIEND, ...over, confirmed: false } as any, ID, fakeSb);
  const call = async (over: Record<string, unknown> = {}) => {
    const p: any = await preview(over);
    return tool_send_calendar_invite_in_chat(
      { event_id: ENTRY, member_user_id: FRIEND, card_token: p.result?.card_token, confirmed: true, ...over } as any, ID, fakeSb);
  };
  const withEntry = (over: Row = {}) => {
    const e = ownEntry(over);
    db.tables.calendar_events.push({ id: ENTRY, user_id: SENDER, title: e.title, start_time: e.start_time, end_time: e.end_time, location: e.location, status: 'confirmed' });
    mockGetOwnEvent.mockResolvedValue(e);
  };

  it('stores a v2 card that the respond/GET path accepts, and pushes a generic body', async () => {
    withEntry();
    const r = await call();
    expect(r.ok).toBe(true);
    expect((r as any).result.sent).toBe(true);
    const row = invites()[0];
    expect(row.metadata).toMatchObject({ kind: 'calendar_invite', v: 2, ref_type: 'calendar_entry', ref_id: ENTRY, title: 'Coffee at Luigi' });
    expect(inviteMetadataOf({ id: row.id, sender_id: SENDER, receiver_id: FRIEND, group_id: null, message_type: row.message_type, metadata: row.metadata })).not.toBeNull();
    expect(mockNotifyAsync).toHaveBeenCalledTimes(1);
    const body = mockNotifyAsync.mock.calls[0][3].body;
    expect(body).toBe(tt('notif.calendar_invite.body', 'de', { name: 'Anna' }));
    expect(body).not.toMatch(/Coffee|Luigi|📅/);
  });

  // VTID-05126 (Codex review): the message text says only what the card shows.
  it('the message text carries the card title, and the place only when shown', async () => {
    withEntry({ title: 'Erinnerung: Kardiologie Dr. Weber' } as Row);
    await call({ card_title: 'Termin' });
    expect(invites()[0].content).toMatch(/^📅 Termin — /);
    expect(invites()[0].content).not.toMatch(/Kardiologie|Weber|Luigi/);
    await call({ card_title: 'Termin', include_location: true });
    expect(invites().at(-1).content).toMatch(/^📅 Termin — .* at Luigi$/);
  });

  it('a confirmed send must carry the previewed card: no token, a dropped title or an added place sends nothing', async () => {
    withEntry();
    const p: any = await preview({ card_title: 'Kaffee' });
    const token = p.result.card_token;
    expect(token).toMatch(/^[0-9a-f]{12}$/);
    const confirm = (over: Record<string, unknown>) =>
      tool_send_calendar_invite_in_chat({ event_id: ENTRY, member_user_id: FRIEND, confirmed: true, ...over } as any, ID, fakeSb);
    for (const over of [{ card_title: 'Kaffee' }, { card_token: token }, { card_title: 'Kaffee', include_location: true, card_token: token }]) {
      expect(await confirm(over)).toMatchObject({ ok: true, result: { needs: 'card_token' } });
    }
    expect(invites()).toHaveLength(0);
    expect(((await confirm({ card_title: 'Kaffee', card_token: token })) as any).result.sent).toBe(true);
    expect(invites()[0].metadata.title).toBe('Kaffee');
  });

  // VTID-05126 (owner decision 2026-10-12): any own upcoming entry can be
  // invited to; a health appointment only after the model surfaced it
  // (sensitive_ack), so a bare confirmation sends nothing.
  it('a health appointment is sent only with sensitive_ack, never on a bare confirmation', async () => {
    withEntry({ source_type: 'health_plan' } as Row);
    const bare = await call();
    expect(bare).toMatchObject({ ok: true, result: { needs: 'sensitive_ack', sensitive: true } });
    expect(invites()).toHaveLength(0);
    expect(mockNotifyAsync).not.toHaveBeenCalled();
    const acked = await call({ sensitive_ack: true });
    expect((acked as any).result.sent).toBe(true);
    expect(invites()).toHaveLength(1);
  });

  it.each([
    ['past entry', { start_time: iso(-3 * HOUR), end_time: iso(-2 * HOUR) }],
    ['recurring entry', { rrule: 'FREQ=WEEKLY' }],
    ['cancelled entry', { status: 'cancelled' }],
  ])('refuses a %s and inserts nothing', async (_n, over) => {
    withEntry(over as Row);
    const r = await call();
    expect(r.ok).toBe(false);
    expect(invites()).toHaveLength(0);
    expect(mockNotifyAsync).not.toHaveBeenCalled();
  });

  it('refuses a recipient the guard refuses (no relationship / test account) with a generic message', async () => {
    withEntry();
    seed({ relationship: 'none' });
    withEntry();
    const none = await call({ member_user_id: STRANGER });
    expect(none).toEqual({ ok: false, error: "I can't send that invite." });
    const bot = await call({ member_user_id: BOT_ACCOUNT });
    expect(bot).toEqual({ ok: false, error: "I can't send that invite." });
    expect(invites()).toHaveLength(0);
  });

  it('the voice quota stays per user: the 6th send is rate limited, whatever the recipient', async () => {
    // fresh sender id so the module-level counter starts at zero
    const id: any = { user_id: SENDER, tenant_id: TENANT, role: 'community', vitana_id: 'anna1' };
    withEntry();
    let limited: any = null;
    const token = ((await preview()) as any).result.card_token;
    for (let i = 0; i < 7; i++) {
      const r: any = await tool_send_calendar_invite_in_chat({ event_id: ENTRY, member_user_id: FRIEND, card_token: token, confirmed: true } as any, id, fakeSb);
      if (r.result?.rate_limited) { limited = r; break; }
    }
    expect(limited).not.toBeNull();
  });

  it('asks for confirmation without sending, and the unconfirmed stage inserts nothing', async () => {
    withEntry();
    const r: any = await call({ confirmed: false });
    expect(r.result.stage).toBe('awaiting_confirmation');
    expect(invites()).toHaveLength(0);
  });
});

// ═══ catalog ═════════════════════════════════════════════════════════════════
describe('generic invite push text', () => {
  it('exists in DE, EN, ES and SR with the name placeholder and no event detail', () => {
    for (const lc of ['de', 'en', 'es', 'sr'] as const) {
      const text = tt('notif.calendar_invite.body', lc, { name: 'Anna' });
      expect(text).toContain('Anna');
      expect(text).not.toBe('notif.calendar_invite.body');
    }
    expect(tt('notif.calendar_invite.body', 'en', { name: 'Anna' })).toBe('Anna invited you to an event');
  });
});
