// VTID-05137 — WhatsApp-style chat pushes: one push per conversation per burst.
//
// Owner report 2026-10-12: three messages from one sender within a minute
// were three separate cards in the Android tray. Appilix (the native apps'
// push path) cannot replace a card, so the fix is to send fewer pushes:
//   - first message → pushes;
//   - more messages in that conversation within 5 min while the pushed one is
//     unread → in-app row only, push_outcome 'coalesced', no FCM/Appilix call;
//   - after the recipient read it → pushes again at once;
//   - after 5 min → pushes, body "{count} new messages · {preview}";
//   - a mention always pushes;
//   - every chat push carries tag chat:<key> (web/FCM replace the card);
//   - a read error fails open (push as before);
//   - CHAT_PUSH_COALESCING_ENABLED=false restores the old behaviour.

const fcmSend = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { applicationDefault: jest.fn() },
  messaging: () => ({ send: (...a: any[]) => fcmSend(...a) }),
}));

const repo = {
  fetchLiveDeviceTokensForUser: jest.fn(),
  revokeDeviceToken: jest.fn().mockResolvedValue({ error: null }),
  fetchDeviceTokenRevocationStates: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchAllDeviceTokensForUser: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchLiveDeviceTokensHeldByOthers: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchActiveNotificationCategories: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchUserCategoryPreference: jest.fn().mockResolvedValue({ data: null, error: null }),
  fetchUserNotificationPreferences: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
  insertUserNotification: jest.fn().mockResolvedValue({ data: { id: 'notif-1' }, error: null }),
  setNotificationPushOutcome: jest.fn().mockResolvedValue({ error: null }),
};
jest.mock('../src/services/notification-service-repository', () => repo);

jest.mock('../src/services/notification-controls/notification-controls-service', () => ({
  isNotificationTypeAllowed: jest.fn().mockResolvedValue(true),
  isMemberCategoryAllowed: jest.fn().mockResolvedValue(true),
  recordNotificationBlock: jest.fn(),
  normalizeSourceKey: (s: unknown) => (typeof s === 'string' ? s : ''),
  isMemberInQuietHours: jest.fn().mockResolvedValue(false),
}));
jest.mock('../src/services/jev/gates/community-ranking-gates', () => ({
  shadowNotificationWorth: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((id) => [id, id === 'u-de' ? 'de' : 'en']))),
}));

import {
  coalesceChatPushes,
  decideChatPushes,
  chatConversationKey,
  chatPushTag,
  CHAT_PUSH_COALESCE_WINDOW_MS,
} from '../src/services/chat-push-coalescer';
import { notifyUser, sendPushNotification } from '../src/services/notification-service';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

type Row = {
  user_id: string;
  created_at: string;
  push_sent_at: string | null;
  push_outcome: string | null;
  data: Record<string, unknown> | null;
};

/** Fake Supabase: records the filters of the coalescer's one read. */
function fakeSupabase(rows: Row[] | Error) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: any = {};
  for (const m of ['select', 'in', 'eq', 'is', 'gte', 'order']) {
    chain[m] = (...a: unknown[]) => {
      calls.push([m, ...a]);
      return chain;
    };
  }
  chain.limit = async (...a: unknown[]) => {
    calls.push(['limit', ...a]);
    if (rows instanceof Error) return { data: null, error: { message: rows.message } };
    return { data: rows, error: null };
  };
  const from = jest.fn((table: string) => {
    calls.push(['from', table]);
    return chain;
  });
  return { sb: { from } as any, calls, from };
}

const pushedRow = (user: string, msAgo: number, extra: Partial<Row> = {}): Row => ({
  user_id: user,
  created_at: ago(msAgo),
  push_sent_at: ago(msAgo),
  push_outcome: 'delivered_appilix',
  data: { conversation_key: 'dm:sender-1' },
  ...extra,
});

const KEY = chatConversationKey({ senderId: 'sender-1' });

describe('conversation key and tag', () => {
  test('DM is keyed by sender, group by group', () => {
    expect(chatConversationKey({ senderId: 's' })).toBe('dm:s');
    expect(chatConversationKey({ senderId: 's', groupId: 'g' })).toBe('group:g');
    expect(chatPushTag('dm:s')).toBe('chat:dm:s');
  });
});

describe('decideChatPushes', () => {
  afterEach(() => {
    delete process.env.CHAT_PUSH_COALESCING_ENABLED;
  });

  test('first message (nothing unread) pushes', async () => {
    const { sb } = fakeSupabase([]);
    const d = await decideChatPushes(sb, ['u1'], KEY, NOW);
    expect(d.get('u1')).toEqual({ push: true, unreadCount: 1 });
  });

  test('a push sent 1 min ago and still unread holds the next one back', async () => {
    const { sb } = fakeSupabase([pushedRow('u1', 60_000)]);
    const d = await decideChatPushes(sb, ['u1'], KEY, NOW);
    expect(d.get('u1')).toEqual({ push: false, unreadCount: 2 });
  });

  test('held-back rows do not count as pushed — the window is anchored on the real push', async () => {
    const { sb } = fakeSupabase([
      pushedRow('u1', 30_000, { push_outcome: 'coalesced', data: { push_coalesced: 'true' } }),
      pushedRow('u1', CHAT_PUSH_COALESCE_WINDOW_MS + 60_000),
    ]);
    const d = await decideChatPushes(sb, ['u1'], KEY, NOW);
    expect(d.get('u1')).toEqual({ push: true, unreadCount: 3 });
  });

  test('a row whose push was suppressed (DND) does not hold the next one back', async () => {
    const { sb } = fakeSupabase([pushedRow('u1', 30_000, { push_outcome: 'suppressed_dnd' })]);
    const d = await decideChatPushes(sb, ['u1'], KEY, NOW);
    expect(d.get('u1')!.push).toBe(true);
  });

  test('one batched read for all recipients, scoped to unread rows of this conversation', async () => {
    const { sb, calls, from } = fakeSupabase([pushedRow('u1', 10_000)]);
    const d = await decideChatPushes(sb, ['u1', 'u2'], KEY, NOW);
    expect(from).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['from', 'user_notifications'],
        ['in', 'user_id', ['u1', 'u2']],
        ['in', 'type', ['new_chat_message', 'chat_mention']],
        ['eq', 'data->>conversation_key', KEY],
        ['is', 'read_at', null],
      ]),
    );
    expect(d.get('u1')!.push).toBe(false);
    expect(d.get('u2')).toEqual({ push: true, unreadCount: 1 });
  });

  test('a read error fails open', async () => {
    const { sb } = fakeSupabase(new Error('boom'));
    const d = await decideChatPushes(sb, ['u1'], KEY, NOW);
    expect(d.get('u1')).toEqual({ push: true, unreadCount: 1 });
  });

  test('CHAT_PUSH_COALESCING_ENABLED=false pushes every message without reading', async () => {
    process.env.CHAT_PUSH_COALESCING_ENABLED = 'false';
    const { sb, from } = fakeSupabase([pushedRow('u1', 10_000)]);
    const d = await decideChatPushes(sb, ['u1'], KEY, NOW);
    expect(from).not.toHaveBeenCalled();
    expect(d.get('u1')).toEqual({ push: true, unreadCount: 1 });
  });
});

describe('coalesceChatPushes', () => {
  const payload = { title: 'Dragan Alexander', body: 'This should replace Google Chat', data: { url: '/inbox/u/sender-1' } };

  test('every payload carries the conversation key and tag', async () => {
    const { sb } = fakeSupabase([]);
    const [p] = await coalesceChatPushes(sb, KEY, [{ userId: 'u1', kind: 'message', payload }], NOW);
    expect(p.payload.tag).toBe('chat:dm:sender-1');
    expect(p.payload.data).toEqual(
      expect.objectContaining({ conversation_key: KEY, tag: 'chat:dm:sender-1', url: '/inbox/u/sender-1' }),
    );
    expect(p.payload.body).toBe(payload.body);
    expect(p.opts).toBeUndefined();
  });

  test('a burst inside the window is held back', async () => {
    const { sb } = fakeSupabase([pushedRow('u1', 60_000)]);
    const [p] = await coalesceChatPushes(sb, KEY, [{ userId: 'u1', kind: 'message', payload }], NOW);
    expect(p.opts).toEqual({ suppressPush: 'coalesced' });
  });

  test('after the window the push summarises the unread messages, in the member\'s language', async () => {
    const old = CHAT_PUSH_COALESCE_WINDOW_MS + 60_000;
    const { sb } = fakeSupabase([
      pushedRow('u-de', old),
      pushedRow('u-de', old - 1000, { push_outcome: 'coalesced', data: { push_coalesced: 'true' } }),
      pushedRow('u-en', old),
    ]);
    const out = await coalesceChatPushes(
      sb,
      KEY,
      [
        { userId: 'u-de', kind: 'message', payload },
        { userId: 'u-en', kind: 'message', payload },
      ],
      NOW,
    );
    const byUser = new Map(out.map((p) => [p.userId, p]));
    expect(byUser.get('u-de')!.opts).toBeUndefined();
    expect(byUser.get('u-de')!.payload.body).toBe('3 neue Nachrichten · This should replace Google Chat');
    expect(byUser.get('u-en')!.payload.body).toBe('2 new messages · This should replace Google Chat');
    expect(byUser.get('u-de')!.payload.title).toBe('Dragan Alexander');
  });

  test('a mention always pushes, unchanged, even inside the window', async () => {
    const { sb } = fakeSupabase([pushedRow('u1', 10_000)]);
    const [p] = await coalesceChatPushes(sb, KEY, [{ userId: 'u1', kind: 'mention', payload }], NOW);
    expect(p.opts).toBeUndefined();
    expect(p.payload.body).toBe(payload.body);
    expect(p.payload.tag).toBe('chat:dm:sender-1');
  });
});

describe('notifyUser with suppressPush: coalesced', () => {
  const fetchMock = jest.fn();
  beforeAll(() => {
    (global as any).fetch = fetchMock;
    process.env.APPILIX_APP_KEY = 'app';
    process.env.APPILIX_API_KEY = 'api';
  });
  beforeEach(() => {
    jest.clearAllMocks();
    repo.fetchLiveDeviceTokensForUser.mockResolvedValue({ data: [{ fcm_token: 'tok-1', device_label: 'Chrome' }], error: null });
    repo.insertUserNotification.mockResolvedValue({ data: { id: 'notif-1' }, error: null });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: true }) });
    fcmSend.mockResolvedValue('msg-id');
  });

  const chatPayload = {
    title: 'Dragan Alexander',
    body: 'hi',
    tag: 'chat:dm:sender-1',
    data: { url: '/inbox/u/sender-1', conversation_key: 'dm:sender-1', tag: 'chat:dm:sender-1' },
  };

  test('writes the in-app row, marks it handled, sends nothing, records coalesced', async () => {
    const r = await notifyUser('u1', 't1', 'new_chat_message', chatPayload, {} as any, { suppressPush: 'coalesced' });
    expect(r).toEqual(expect.objectContaining({ pushed: 0, inapp: true }));
    expect(fcmSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const row = repo.insertUserNotification.mock.calls[0][1];
    expect(row.push_sent_at).toEqual(expect.any(String));
    expect(row.data).toEqual(expect.objectContaining({ push_coalesced: 'true', conversation_key: 'dm:sender-1' }));
    expect(repo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-1', 'coalesced');
  });

  test('without the option the same payload pushes as before', async () => {
    const r = await notifyUser('u1', 't1', 'new_chat_message', chatPayload, {} as any);
    expect(r.suppressed).toBeUndefined();
    expect(repo.setNotificationPushOutcome).toHaveBeenCalledWith(expect.anything(), 'notif-1', 'delivered_appilix');
    expect(fetchMock).toHaveBeenCalled(); // deep link → Appilix first
    const row = repo.insertUserNotification.mock.calls[0][1];
    expect(row.data).not.toHaveProperty('push_coalesced');
  });

  test('FCM/web push carries the chat tag so the card is replaced', async () => {
    await sendPushNotification('tok-1', chatPayload);
    const msg = fcmSend.mock.calls[0][0];
    expect(msg.android.notification.tag).toBe('chat:dm:sender-1');
    expect(msg.webpush.notification.tag).toBe('chat:dm:sender-1');
    expect(msg.apns.headers['apns-collapse-id']).toBe('chat:dm:sender-1');
  });
});
