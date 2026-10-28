// VTID-05312 (messenger-ux-v2/api-viewing-presence) — no chat push for the
// conversation the recipient is looking at (owner requirement R13).
//
// Contract (plan .kiro/specs/messenger-ux-v2/plan.md I4):
//   - the key is the recipient's view: DM A→B is suppressed when B views dm:<A>;
//     B viewing dm:<C> or A's own presence never suppresses B's push; group by
//     group:<id>; conversation_key in the payload is a cross-check only;
//   - checked centrally in notifyUser (row written with push_sent_at at INSERT,
//     outcome suppressed_viewing, no FCM/Appilix) and in /push-dispatch;
//   - every push caller is covered without being edited (payload shapes);
//   - listing_interest and other types are never suppressed;
//   - expired rows (> 45 s) do not suppress; any device / tab suppresses;
//   - dedup: two rows for one recipient and message push once (both orders and
//     both unpushed in one batch), the other row suppressed_duplicate;
//   - fails open; CHAT_PUSH_VIEWING_SUPPRESSION_ENABLED=false turns it off;
//   - POST /chat/viewing validates and upserts / deletes per (user, device).

import express from 'express';
import request from 'supertest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const G = '44444444-4444-4444-8444-444444444444';
const MID = '55555555-5555-4555-8555-555555555555';

// ── In-memory Supabase (presence + chat_messages + user_notifications) ──────
type Row = Record<string, any>;
const db: Record<string, Row[]> = { chat_viewing_presence: [], chat_messages: [], user_notifications: [] };
let presenceReadFails = false;
const selectCount: Record<string, number> = {};
const inCalls: Array<[string, string, unknown[]]> = [];
class Q {
  private f: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'delete' | 'update' | 'upsert' = 'select';
  private payload: Row | null = null;
  constructor(private t: string) {}
  select() { return this; }
  delete() { this.op = 'delete'; return this; }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  upsert(p: Row) { this.op = 'upsert'; this.payload = p; return this; }
  eq(c: string, v: unknown) { this.f.push((r) => (c === 'data->>message_id' ? r.data?.message_id === v : r[c] === v)); return this; }
  in(c: string, vs: unknown[]) { inCalls.push([this.t, c, vs]); this.f.push((r) => vs.includes(c === 'data->>message_id' ? r.data?.message_id : r[c])); return this; }
  is(c: string, v: null) { this.f.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _op: string, _v: null) { this.f.push((r) => (r[c] ?? null) !== null); return this; }
  gt(c: string, v: string) { this.f.push((r) => r[c] > v); return this; }
  gte(c: string, v: string) { this.f.push((r) => r[c] >= v); return this; }
  order() { return this; }
  lt(c: string, v: string) { this.f.push((r) => r[c] < v); return this; }
  limit() { return this; }
  then(resolve: any, reject: any) { return this.run().then(resolve, reject); }
  private async run() {
    if (this.op === 'select') selectCount[this.t] = (selectCount[this.t] ?? 0) + 1;
    if (this.t === 'chat_viewing_presence' && this.op === 'select' && presenceReadFails) return { data: null, error: { message: 'boom' } };
    const rows = (db[this.t] ??= []);
    if (this.op === 'upsert') {
      const p = this.payload!;
      const i = rows.findIndex((r) => r.user_id === p.user_id && r.device_id === p.device_id);
      if (i >= 0) rows[i] = p; else rows.push(p);
      return { data: null, error: null };
    }
    const hit = rows.filter((r) => this.f.every((x) => x(r)));
    if (this.op === 'delete') { db[this.t] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
    if (this.op === 'update') { hit.forEach((r) => Object.assign(r, this.payload)); return { data: null, error: null }; }
    return { data: hit.map((r) => (this.t === 'user_notifications' ? { id: r.id, user_id: r.user_id, message_id: r.data?.message_id } : { ...r })), error: null };
  }
}
const sb = { from: (t: string) => new Q(t) };
jest.mock('@supabase/supabase-js', () => ({ createClient: () => sb }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'k';

const fcmSend = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [], initializeApp: jest.fn(), credential: { applicationDefault: jest.fn() },
  messaging: () => ({ send: (...a: any[]) => fcmSend(...a) }),
}));
const nrepo = {
  fetchLiveDeviceTokensForUser: jest.fn().mockResolvedValue({ data: [{ fcm_token: 'tok-1', device_label: 'Chrome' }], error: null }),
  revokeDeviceToken: jest.fn().mockResolvedValue({ error: null }),
  fetchDeviceTokenRevocationStates: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchAllDeviceTokensForUser: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchLiveDeviceTokensHeldByOthers: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchActiveNotificationCategories: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchUserCategoryPreference: jest.fn().mockResolvedValue({ data: null, error: null }),
  fetchUserNotificationPreferences: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
  insertUserNotification: jest.fn().mockResolvedValue({ data: { id: 'notif-1' }, error: null }),
  setNotificationPushOutcome: jest.fn().mockResolvedValue({ error: null }),
  markUnpushedChatDuplicatesHandled: jest.fn(async (s: any, userId: string, messageId: string) =>
    jest.requireActual('../src/services/notification-service-repository').markUnpushedChatDuplicatesHandled(s, userId, messageId)),
};
jest.mock('../src/services/notification-service-repository', () => nrepo);
const controls = {
  isNotificationTypeAllowed: jest.fn().mockResolvedValue(true),
  isMemberCategoryAllowed: jest.fn().mockResolvedValue(true),
  recordNotificationBlock: jest.fn(),
  normalizeSourceKey: (s: unknown) => (typeof s === 'string' ? s : ''),
  isMemberInQuietHours: jest.fn().mockResolvedValue(false),
};
jest.mock('../src/services/notification-controls/notification-controls-service', () => controls);
jest.mock('../src/services/jev/gates/community-ranking-gates', () => ({ shadowNotificationWorth: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn().mockResolvedValue(null),
  requireAuth: (req: any, _res: any, next: any) => { req.identity = { user_id: '22222222-2222-4222-8222-222222222222', tenant_id: 't1' }; next(); },
  requireTenant: (_req: any, _res: any, next: any) => next(),
}));

import {
  chatConversationKeyFromData, isViewingChat, viewingPairs, VIEWING_TTL_MS,
} from '../src/services/chat-viewing-presence';
import { notifyUser } from '../src/services/notification-service';

const fetchMock = jest.fn();
beforeAll(() => {
  (global as any).fetch = fetchMock;
  process.env.APPILIX_APP_KEY = 'app';
  process.env.APPILIX_API_KEY = 'api';
});

const future = () => new Date(Date.now() + VIEWING_TTL_MS).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();
function viewing(userId: string, key: string, device = 'tab-aaaaaaa1', expires = future(), tenant = 't1') {
  db.chat_viewing_presence.push({ user_id: userId, device_id: device, tenant_id: tenant, conversation_key: key, expires_at: expires });
}

beforeEach(() => {
  db.chat_viewing_presence = [];
  db.chat_messages = [];
  db.user_notifications = [];
  presenceReadFails = false;
  for (const k of Object.keys(selectCount)) delete selectCount[k];
  inCalls.length = 0;
  delete process.env.CHAT_PUSH_VIEWING_SUPPRESSION_ENABLED;
  jest.clearAllMocks();
  nrepo.insertUserNotification.mockResolvedValue({ data: { id: 'notif-1' }, error: null });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: true }) });
  fcmSend.mockResolvedValue('msg-id');
});

describe('key = the recipient\'s view', () => {
  it('group_id first, then sender_id; conversation_key is only a cross-check', () => {
    expect(chatConversationKeyFromData({ group_id: G, sender_id: A })).toBe(`group:${G}`);
    expect(chatConversationKeyFromData({ sender_id: A, conversation_key: `dm:${C}` })).toBe(`dm:${A}`);
    expect(chatConversationKeyFromData({ conversation_key: `dm:${A}` })).toBeNull();
    expect(chatConversationKeyFromData(null)).toBeNull();
  });

  it('DM A→B: B viewing dm:<A> → viewing; B viewing dm:<C> → not; A\'s own presence never counts', async () => {
    viewing(B, `dm:${A}`);
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { sender_id: A })).toBe(true);
    db.chat_viewing_presence = [];
    viewing(B, `dm:${C}`);
    viewing(A, `dm:${B}`);
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { sender_id: A })).toBe(false);
  });

  it('an expired row does not count; another device or tab does', async () => {
    viewing(B, `dm:${A}`, 'tab-old00001', past());
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { sender_id: A })).toBe(false);
    viewing(B, `dm:${A}`, 'phone-000001');
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { sender_id: A })).toBe(true);
  });

  it('only chat types; a read error or the off switch → not viewing (push as before)', async () => {
    viewing(B, `dm:${A}`);
    expect(await isViewingChat(sb as any, B, 't1', 'listing_interest', { sender_id: A })).toBe(false);
    presenceReadFails = true;
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { sender_id: A })).toBe(false);
    presenceReadFails = false;
    process.env.CHAT_PUSH_VIEWING_SUPPRESSION_ENABLED = 'false';
    expect(await viewingPairs(sb as any, [{ userId: B, tenantId: 't1', key: `dm:${A}` }])).toEqual(new Set());
  });

  it('the presence must be of the push\'s tenant; a push without a tenant is never suppressed', async () => {
    viewing(B, `dm:${A}`, 'tab-aaaaaaa1', future(), 't2');
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { sender_id: A })).toBe(false);
    expect(await isViewingChat(sb as any, B, 't2', 'new_chat_message', { sender_id: A })).toBe(true);
    expect(await isViewingChat(sb as any, B, '', 'new_chat_message', { sender_id: A })).toBe(false);
    const r = await notifyUser(B, 't1', 'new_chat_message', { title: 'T', body: 'b', data: { sender_id: A } }, sb as any);
    expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-1', expect.stringMatching(/^delivered_/));
    expect(r).toEqual(expect.objectContaining({ inapp: true }));
  });

  it('a payload with only message_id is keyed by one chat_messages lookup', async () => {
    db.chat_messages.push({ id: MID, sender_id: A, group_id: null });
    viewing(B, `dm:${A}`);
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { message_id: MID })).toBe(true);
  });
});

describe('notifyUser (every caller, no caller edited)', () => {
  const callers: Array<[string, string, Record<string, string>, string]> = [
    ['chat.ts /send DM', 'new_chat_message', { type: 'new_chat_message', sender_id: A, message_id: MID, thread_id: A, url: `/inbox/u/${A}`, conversation_key: `dm:${A}` }, `dm:${A}`],
    ['chat.ts calendar invite (DM)', 'new_chat_message', { type: 'new_chat_message', sender_id: A, message_id: MID, url: `/inbox/u/${A}` }, `dm:${A}`],
    ['new-member greeting', 'new_chat_message', { type: 'new_chat_message', sender_id: A, conversation_key: `dm:${A}`, greeting_group: 'new_member_greeting' }, `dm:${A}`],
    ['group fanout message', 'new_chat_message', { type: 'new_group_message', group_id: G, sender_id: A, message_id: MID }, `group:${G}`],
    ['group fanout mention', 'chat_mention', { type: 'chat_mention', group_id: G, sender_id: A, message_id: MID }, `group:${G}`],
    ['group fanout calendar invite', 'new_chat_message', { type: 'new_group_message', group_id: G, sender_id: A, message_id: MID }, `group:${G}`],
    ['welcome refanout', 'new_chat_message', { type: 'new_group_message', group_id: G, sender_id: A }, `group:${G}`],
    ['orb-tools-shared voice send', 'new_chat_message', { type: 'new_chat_message', sender_id: A, thread_id: A }, `dm:${A}`],
    ['messaging-depth-tools', 'new_chat_message', { type: 'new_chat_message', sender_id: A, url: `/inbox/u/${A}` }, `dm:${A}`],
    ['calendar-social-tools', 'new_chat_message', { type: 'new_chat_message', sender_id: A, message_id: '', thread_id: A }, `dm:${A}`],
    ['welcome-team', 'new_chat_message', { type: 'new_chat_message', sender_id: A, thread_id: A, url: `/inbox/u/${A}` }, `dm:${A}`],
  ];

  it.each(callers)('%s: viewing → row written, push_sent_at at INSERT, no push, suppressed_viewing; not viewing → pushed', async (_l, type, data, key) => {
    viewing(B, key);
    const r = await notifyUser(B, 't1', type, { title: 'T', body: 'b', data }, sb as any);
    expect(r).toEqual(expect.objectContaining({ pushed: 0, inapp: true }));
    expect(fcmSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nrepo.insertUserNotification.mock.calls[0][1].push_sent_at).toEqual(expect.any(String));
    expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-1', 'suppressed_viewing');

    jest.clearAllMocks();
    nrepo.insertUserNotification.mockResolvedValue({ data: { id: 'notif-2' }, error: null });
    db.chat_viewing_presence = [];
    await notifyUser(B, 't1', type, { title: 'T', body: 'b', data }, sb as any);
    expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-2', expect.stringMatching(/^delivered_/));
  });

  it('group: a viewing member gets no push for a message or a mention, a non-viewing member of the same group does', async () => {
    viewing(B, `group:${G}`);
    for (const type of ['new_chat_message', 'chat_mention']) {
      jest.clearAllMocks();
      nrepo.insertUserNotification.mockResolvedValue({ data: { id: 'n-b' }, error: null });
      await notifyUser(B, 't1', type, { title: 'T', body: 'b', data: { group_id: G, sender_id: A, message_id: MID } }, sb as any);
      expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'n-b', 'suppressed_viewing');
      nrepo.insertUserNotification.mockResolvedValue({ data: { id: 'n-c' }, error: null });
      await notifyUser(C, 't1', type, { title: 'T', body: 'b', data: { group_id: G, sender_id: A, message_id: MID } }, sb as any);
      expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'n-c', expect.stringMatching(/^delivered_/));
    }
  });

  it('a suppressed_viewing row is never sent later by /push-dispatch, even after the presence expired (push_sent_at at INSERT)', async () => {
    viewing(B, `dm:${A}`);
    await notifyUser(B, 't1', 'new_chat_message', { title: 'T', body: 'b', data: { sender_id: A, message_id: MID } }, sb as any);
    const inserted = nrepo.insertUserNotification.mock.calls[0][1];
    expect(inserted.push_sent_at).toEqual(expect.any(String));
    db.chat_viewing_presence = []; // presence gone
    db.user_notifications.push({ id: 'notif-1', ...inserted, created_at: new Date().toISOString() });
    const { fetchPendingPushNotifications: realPending } = jest.requireActual('../src/routes/scheduled-notifications-repository');
    const { data } = await realPending(sb, new Date(Date.now() - 3600_000).toISOString());
    expect((data as Row[]).map((r) => r.id)).not.toContain('notif-1');
  });

  it('the email fallback never runs for suppressed_viewing / suppressed_duplicate', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EMAIL_FALLBACK_OUTCOMES } = jest.requireActual('../src/services/email/notification-email-fallback');
    expect(EMAIL_FALLBACK_OUTCOMES).not.toContain('suppressed_viewing');
    expect(EMAIL_FALLBACK_OUTCOMES).not.toContain('suppressed_duplicate');
  });

  it('a failed dedup write (e.g. the old CHECK) is logged, and the push still goes out', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    nrepo.markUnpushedChatDuplicatesHandled.mockResolvedValueOnce({ error: { message: 'violates check constraint' } } as any);
    await notifyUser(B, 't1', 'new_chat_message', { title: 'T', body: 'b', data: { sender_id: A, message_id: MID } }, sb as any);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('chat dedup failed') && String(c[0]).includes('violates check constraint'))).toBe(true);
    expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-1', expect.stringMatching(/^delivered_/));
    warn.mockRestore();
  });

  it('listing_interest is never suppressed', async () => {
    viewing(B, `dm:${A}`);
    await notifyUser(B, 't1', 'listing_interest', { title: 'T', body: 'b', data: { sender_id: A, url: `/inbox/u/${A}` } }, sb as any);
    expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-1', expect.stringMatching(/^delivered_/));
  });

  it('dedup (b): an unpushed row of the same recipient and message is marked suppressed_duplicate before this one is written', async () => {
    db.user_notifications.push({ id: 'trigger-row', user_id: B, type: 'new_chat_message', data: { message_id: MID, url: '/inbox' }, push_sent_at: null });
    await notifyUser(B, 't1', 'new_chat_message', { title: 'T', body: 'b', data: { sender_id: A, message_id: MID } }, sb as any);
    const trig = db.user_notifications.find((r) => r.id === 'trigger-row')!;
    expect(trig.push_sent_at).toEqual(expect.any(String));
    expect(trig.push_outcome).toBe('suppressed_duplicate');
  });
});

// ── /push-dispatch (rows written without notifyUser, e.g. the vitana-v1 trigger) ──
const sendPushToUser = jest.fn();
const recordPushOutcome = jest.fn().mockResolvedValue(undefined);
const dispatchPush = jest.fn().mockResolvedValue({ sent: 1, appilixSent: false });
const markNotificationPushSent = jest.fn().mockResolvedValue({ error: null });
const fetchPendingPushNotifications = jest.fn();
let cronApp: express.Express;
beforeAll(() => {
  jest.isolateModules(() => {
    jest.doMock('../src/services/notification-service', () => ({
      notifyUser: jest.fn(), notifyUserAsync: jest.fn(),
      sendPushToUser: (...a: any[]) => sendPushToUser(...a),
      isSignedOutOnAllKnownDevices: jest.fn().mockResolvedValue(false),
      TYPE_META: {},
      newPushFanoutOutcome: () => ({ sent: 0, stale: 0, errors: 0 }),
      classifyPushOutcome: () => 'delivered_fcm',
      recordPushOutcome: (...a: any[]) => recordPushOutcome(...a),
    }));
    jest.doMock('../src/services/push-routing', () => ({ dispatchPush: (...a: any[]) => dispatchPush(...a) }));
    jest.doMock('../src/routes/scheduled-notifications-repository', () => ({
      ...jest.requireActual('../src/routes/scheduled-notifications-repository'),
      fetchPendingPushNotifications: (...a: any[]) => fetchPendingPushNotifications(...a),
      fetchUserNotificationPreferences: jest.fn().mockResolvedValue({ data: null, error: null }),
      markNotificationPushSent: (...a: any[]) => markNotificationPushSent(...a),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/scheduled-notifications').default;
    cronApp = express();
    cronApp.use(express.json());
    cronApp.use('/sn', router);
  });
});
const pendingRow = (id: string, user: string, data: Row, type = 'new_chat_message', created = '2026-10-21T10:00:00Z') =>
  ({ id, user_id: user, tenant_id: 't1', type, title: 'T', body: 'b', data, channel: 'push_and_inapp', priority: 'p1', created_at: created });
async function runCron(rows: Row[]) {
  fetchPendingPushNotifications.mockResolvedValue({ data: rows, error: null });
  return request(cronApp).post('/sn/push-dispatch').send({});
}
const outcomes = () => Object.fromEntries(recordPushOutcome.mock.calls.map((c) => [c[1], c[2]]));

describe('/push-dispatch', () => {
  beforeEach(() => { dispatchPush.mockClear(); recordPushOutcome.mockClear(); });

  it('a trigger-style row (url /inbox, no conversation_key) is keyed via sender/message and suppressed while viewing', async () => {
    db.chat_messages.push({ id: MID, sender_id: A, group_id: null });
    viewing(B, `dm:${A}`);
    await runCron([pendingRow('r1', B, { message_id: MID, entity_id: MID, url: '/inbox' })]);
    expect(outcomes()).toEqual({ r1: 'suppressed_viewing' });
    expect(dispatchPush).not.toHaveBeenCalled();
  });

  it('a batch of N rows that need the message lookup: one chat_messages read and one presence read', async () => {
    const ids = ['66666666-6666-4666-8666-000000000001', '66666666-6666-4666-8666-000000000002', '66666666-6666-4666-8666-000000000003'];
    for (const id of ids) db.chat_messages.push({ id, sender_id: A, group_id: null });
    viewing(B, `dm:${A}`);
    await runCron(ids.map((id, i) => pendingRow(`r${i}`, B, { message_id: id, url: '/inbox' }, 'new_chat_message', `2026-10-21T10:00:0${i}Z`)));
    expect(selectCount.chat_messages).toBe(1);
    expect(selectCount.chat_viewing_presence).toBe(1);
    expect(outcomes()).toEqual({ r0: 'suppressed_viewing', r1: 'suppressed_viewing', r2: 'suppressed_viewing' });
  });

  it('not viewing → pushed', async () => {
    db.chat_messages.push({ id: MID, sender_id: A, group_id: null });
    await runCron([pendingRow('r1', B, { message_id: MID, url: '/inbox' })]);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual({ r1: 'delivered_fcm' });
  });

  it('dedup (a): two unpushed rows for one recipient and message in one batch → one push, the newer suppressed_duplicate', async () => {
    db.chat_messages.push({ id: MID, sender_id: A, group_id: null });
    await runCron([
      pendingRow('older', B, { message_id: MID, sender_id: A }, 'new_chat_message', '2026-10-21T10:00:00Z'),
      pendingRow('newer', B, { message_id: MID, url: '/inbox' }, 'new_chat_message', '2026-10-21T10:00:01Z'),
    ]);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual({ older: 'delivered_fcm', newer: 'suppressed_duplicate' });
  });

  it('dedup (a): a row whose sibling was already pushed (gateway row first) → suppressed_duplicate', async () => {
    db.user_notifications.push({ id: 'gw-row', user_id: B, type: 'new_chat_message', data: { message_id: MID }, push_sent_at: '2026-10-21T09:59:59Z' });
    await runCron([pendingRow('trig', B, { message_id: MID, url: '/inbox' })]);
    expect(dispatchPush).not.toHaveBeenCalled();
    expect(outcomes()).toEqual({ trig: 'suppressed_duplicate' });
    // The sibling read is scoped to the batch's recipients.
    expect(inCalls).toContainEqual(['user_notifications', 'user_id', [B]]);
  });

  it('other notification types pass through untouched', async () => {
    viewing(B, `dm:${A}`);
    await runCron([pendingRow('p1', B, { sender_id: A }, 'community_post_published')]);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
  });
});

describe('POST /chat/viewing', () => {
  let app: express.Express;
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const viewingRouter = require('../src/routes/chat-viewing').default;
    app = express();
    app.use(express.json());
    app.use('/chat/viewing', viewingRouter);
  });

  it('active:true upserts one row per (user, device) with a 45 s expiry; active:false deletes it', async () => {
    const r1 = await request(app).post('/chat/viewing').send({ conversation_key: `dm:${A}`, device_id: 'tab-abcdef01', active: true });
    expect(r1.status).toBe(200);
    await request(app).post('/chat/viewing').send({ conversation_key: `group:${G}`, device_id: 'tab-abcdef01', active: true });
    expect(db.chat_viewing_presence).toHaveLength(1);
    expect(db.chat_viewing_presence[0]).toMatchObject({ user_id: B, conversation_key: `group:${G}`, tenant_id: 't1' });
    const ttl = new Date(db.chat_viewing_presence[0].expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(40_000);
    expect(ttl).toBeLessThanOrEqual(45_000);
    await request(app).post('/chat/viewing').send({ device_id: 'tab-abcdef01', active: false });
    expect(db.chat_viewing_presence).toHaveLength(0);
  });

  it('active:false with a conversation_key clears only that conversation (a late false for A keeps B)', async () => {
    await request(app).post('/chat/viewing').send({ conversation_key: `group:${G}`, device_id: 'tab-abcdef01', active: true });
    await request(app).post('/chat/viewing').send({ conversation_key: `dm:${A}`, device_id: 'tab-abcdef01', active: false });
    expect(db.chat_viewing_presence).toHaveLength(1);
    await request(app).post('/chat/viewing').send({ conversation_key: `group:${G}`, device_id: 'tab-abcdef01', active: false });
    expect(db.chat_viewing_presence).toHaveLength(0);
  });

  it('after active:false the next chat push goes out', async () => {
    await request(app).post('/chat/viewing').send({ conversation_key: `dm:${A}`, device_id: 'tab-abcdef01', active: true });
    expect(await isViewingChat(sb as any, B, 't1', 'new_chat_message', { sender_id: A })).toBe(true);
    await request(app).post('/chat/viewing').send({ device_id: 'tab-abcdef01', active: false });
    await notifyUser(B, 't1', 'new_chat_message', { title: 'T', body: 'b', data: { sender_id: A } }, sb as any);
    expect(nrepo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-1', expect.stringMatching(/^delivered_/));
  });

  it('expired rows of the caller are removed on write', async () => {
    viewing(B, `dm:${C}`, 'old-tab-0001', past());
    await request(app).post('/chat/viewing').send({ conversation_key: `dm:${A}`, device_id: 'tab-abcdef01', active: true });
    expect(db.chat_viewing_presence.map((r) => r.device_id)).toEqual(['tab-abcdef01']);
  });

  it.each([
    [{ conversation_key: 'dm:nope', device_id: 'tab-abcdef01', active: true }, 'invalid_conversation_key'],
    [{ conversation_key: `dm:${A}`, device_id: 'x', active: true }, 'invalid_device_id'],
    [{ conversation_key: `dm:${A}`, device_id: 'tab-abcdef01', active: 'yes' }, 'invalid_active'],
  ])('refuses %o', async (body, error) => {
    const r = await request(app).post('/chat/viewing').send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(error);
  });
});

describe('migration', () => {
  it('the push_outcome CHECK keeps every earlier value and adds the two new ones', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const dir = path.join(__dirname, '../../../supabase/migrations');
    const values = (file: string) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const block = sql.slice(sql.indexOf('push_outcome IN ('));
      return new Set((block.slice(0, block.indexOf(')')).match(/'([a-z_]+)'/g) || []).map((v: string) => v.replace(/'/g, '')));
    };
    const before = values('20261013180000_vtid_05137_chat_push_coalescing.sql');
    const after = values('20261021150000_vtid_05312_chat_viewing_presence.sql');
    for (const v of before) expect(after.has(v)).toBe(true);
    expect(after.has('suppressed_viewing')).toBe(true);
    expect(after.has('suppressed_duplicate')).toBe(true);
    expect(after.size).toBe(before.size + 2);
  });
});
