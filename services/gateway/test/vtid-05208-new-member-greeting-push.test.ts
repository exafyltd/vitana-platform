// VTID-05208 — grouped pushes for new-member greeting DMs (plan S4, owner D2 = b).
//
// A newcomer greeted by many members by private DM gets ONE push per 24 h:
//   - the first greeting pushes (tag chat:new_member_greeting);
//   - later greetings in the window write their in-app row, push_outcome
//     'coalesced', no FCM/Appilix call (D2 golden: N senders → N rows, 1 push);
//   - a push after the window, with greetings still inside it, reads
//     "{count} people said hello 👋" in the recipient's language;
//   - reading does not reset the window; one sender counts once;
//   - a read error or NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED=false falls
//     back to the VTID-05137 per-conversation coalescing;
//   - test/service accounts (or a failed exclusion lookup) → no notification;
//   - the two catalog keys exist in all 11 shipped locales.

const fcmSend = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { applicationDefault: jest.fn() },
  messaging: () => ({ send: (...a: any[]) => fcmSend(...a) }),
}));

type Row = {
  id: string;
  user_id: string;
  type: string;
  created_at: string;
  push_sent_at: string | null;
  push_outcome: string | null;
  read_at: string | null;
  data: Record<string, unknown> | null;
  title?: string;
  body?: string;
};

// In-memory user_notifications table shared by the repo mock and the fake client.
const store: { rows: Row[]; clock: number; seq: number } = { rows: [], clock: 0, seq: 0 };

const repo = {
  fetchLiveDeviceTokensForUser: jest.fn(),
  revokeDeviceToken: jest.fn().mockResolvedValue({ error: null }),
  fetchDeviceTokenRevocationStates: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchAllDeviceTokensForUser: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchLiveDeviceTokensHeldByOthers: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchActiveNotificationCategories: jest.fn().mockResolvedValue({ data: [], error: null }),
  fetchUserCategoryPreference: jest.fn().mockResolvedValue({ data: null, error: null }),
  fetchUserNotificationPreferences: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
  insertUserNotification: jest.fn(async (_sb: unknown, row: Record<string, any>) => {
    const id = `notif-${++store.seq}`;
    store.rows.push({
      id,
      user_id: row.user_id,
      type: row.type,
      created_at: new Date(store.clock).toISOString(),
      push_sent_at: row.push_sent_at ?? null,
      push_outcome: null,
      read_at: null,
      data: row.data ?? null,
      title: row.title,
      body: row.body,
    });
    return { data: { id }, error: null };
  }),
  setNotificationPushOutcome: jest.fn(async (_sb: unknown, id: string, outcome: string) => {
    const r = store.rows.find((x) => x.id === id);
    if (r) r.push_outcome = outcome;
    return { error: null };
  }),
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
  getUserLocale: jest.fn(async (_sb: unknown, id: string) => (id === 'u-de' ? 'de' : id === 'u-ar' ? 'ar' : 'en')),
  bulkGetUserLocales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((id) => [id, id === 'u-de' ? 'de' : 'en']))),
}));

import {
  prepareNewMemberGreetingPush,
  decideGreetingPush,
  isNewMemberGreeting,
  GREETING_PUSH_TAG,
  GREETING_PUSH_WINDOW_MS,
} from '../src/services/new-member-greeting-push';
import { notifyUser } from '../src/services/notification-service';
import { GATEWAY_LOCALES, tt } from '../src/i18n/catalog';

import de from '../src/i18n/locales/de.json';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import sr from '../src/i18n/locales/sr.json';
import fr from '../src/i18n/locales/fr.json';
import pt from '../src/i18n/locales/pt.json';
import ru from '../src/i18n/locales/ru.json';
import pl from '../src/i18n/locales/pl.json';
import zh from '../src/i18n/locales/zh.json';
import ar from '../src/i18n/locales/ar.json';
import tr from '../src/i18n/locales/tr.json';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

type Exclusion = { ids?: string[]; error?: boolean };

/** Fake Supabase over `store`, plus the two exclusion tables. */
function fakeSupabase(opts: { exclusion?: Exclusion; failGreetingRead?: boolean } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const from = jest.fn((table: string) => {
    calls.push(['from', table]);
    if (table === 'service_bot_accounts' || table === 'notification_test_actors') {
      return {
        select: async () => {
          if (opts.exclusion?.error) return { data: null, error: { message: 'lookup down' } };
          const ids = table === 'notification_test_actors' ? opts.exclusion?.ids ?? [] : [];
          return { data: ids.map((user_id) => ({ user_id })), error: null };
        },
      };
    }
    const filters: Array<(r: Row) => boolean> = [];
    let greetingRead = false;
    const field = (r: Row, col: string): unknown =>
      col.startsWith('data->>') ? (r.data ?? {})[col.slice(7)] : (r as any)[col];
    const chain: any = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
      eq: (col: string, v: unknown) => {
        calls.push(['eq', col, v]);
        if (col === 'data->>greeting_group') greetingRead = true;
        filters.push((r) => field(r, col) === v);
        return chain;
      },
      in: (col: string, vs: unknown[]) => {
        calls.push(['in', col, vs]);
        filters.push((r) => vs.includes(field(r, col)));
        return chain;
      },
      is: (col: string, v: unknown) => {
        calls.push(['is', col, v]);
        filters.push((r) => (field(r, col) ?? null) === v);
        return chain;
      },
      gte: (col: string, v: string) => {
        calls.push(['gte', col, v]);
        filters.push((r) => String(field(r, col)) >= v);
        return chain;
      },
      order: (...a: unknown[]) => (calls.push(['order', ...a]), chain),
      limit: async (n: number) => {
        calls.push(['limit', n]);
        if (greetingRead && opts.failGreetingRead) return { data: null, error: { message: 'boom' } };
        const out = store.rows
          .filter((r) => filters.every((f) => f(r)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, n);
        return { data: out, error: null };
      },
    };
    return chain;
  });
  return { sb: { from } as any, calls, from };
}

const greetingPayload = (sender: string) => ({
  title: `Member ${sender}`,
  body: 'Welcome! Great to have you here.',
  data: { type: 'new_chat_message', sender_id: sender, url: `/inbox/u/${sender}` },
});

/** A greeting row already in the table (seeded history). */
function seedGreeting(receiver: string, sender: string, at: number, pushed: boolean, extra: Partial<Row> = {}) {
  store.rows.push({
    id: `seed-${++store.seq}`,
    user_id: receiver,
    type: 'new_chat_message',
    created_at: iso(at),
    push_sent_at: iso(at),
    push_outcome: pushed ? 'delivered_appilix' : 'coalesced',
    read_at: null,
    data: {
      sender_id: sender,
      conversation_key: `dm:${sender}`,
      greeting_group: 'new_member_greeting',
      ...(pushed ? {} : { push_coalesced: 'true' }),
    },
    ...extra,
  });
}

const fetchMock = jest.fn();
beforeAll(() => {
  (global as any).fetch = fetchMock;
  process.env.APPILIX_APP_KEY = 'app';
  process.env.APPILIX_API_KEY = 'api';
});
beforeEach(() => {
  jest.clearAllMocks();
  store.rows = [];
  store.seq = 0;
  store.clock = NOW;
  delete process.env.NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED;
  delete process.env.CHAT_PUSH_COALESCING_ENABLED;
  repo.fetchLiveDeviceTokensForUser.mockResolvedValue({ data: [{ fcm_token: 'tok-1', device_label: 'Chrome' }], error: null });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: true }) });
  fcmSend.mockResolvedValue('msg-id');
});

const pushCalls = () => fetchMock.mock.calls.length + fcmSend.mock.calls.length;

describe('isNewMemberGreeting', () => {
  test('true only for the exact tag', () => {
    expect(isNewMemberGreeting({ source: 'new_member_greeting' })).toBe(true);
    expect(isNewMemberGreeting({ source: 'New_Member_Greeting' })).toBe(false);
    expect(isNewMemberGreeting({ source: 'community_marketplace' })).toBe(false);
    expect(isNewMemberGreeting({})).toBe(false);
    expect(isNewMemberGreeting(null)).toBe(false);
    expect(isNewMemberGreeting(undefined)).toBe(false);
  });
});

describe('prepareNewMemberGreetingPush', () => {
  test('a) the first greeting pushes, payload unchanged except tag and grouping data', async () => {
    const { sb } = fakeSupabase();
    const p = await prepareNewMemberGreetingPush(sb, { senderId: 's1', receiverId: 'u-de', payload: greetingPayload('s1') }, NOW);
    expect(p).not.toBeNull();
    expect(p!.opts).toBeUndefined();
    expect(p!.payload.title).toBe('Member s1');
    expect(p!.payload.body).toBe('Welcome! Great to have you here.');
    expect(p!.payload.tag).toBe(GREETING_PUSH_TAG);
    expect(GREETING_PUSH_TAG).toBe('chat:new_member_greeting');
    expect(p!.payload.data).toEqual(
      expect.objectContaining({
        sender_id: 's1',
        url: '/inbox/u/s1',
        conversation_key: 'dm:s1',
        tag: 'chat:new_member_greeting',
        greeting_group: 'new_member_greeting',
        greeting_count: '1',
      }),
    );
  });

  test('b) D2 golden: 5 greetings from 5 senders within 24 h → 5 in-app rows, exactly 1 push', async () => {
    const { sb } = fakeSupabase();
    const senders = ['s1', 's2', 's3', 's4', 's5'];
    const pushesAfter: number[] = [];
    for (let i = 0; i < senders.length; i++) {
      store.clock = NOW + i * 2 * HOUR;
      const prepared = await prepareNewMemberGreetingPush(
        sb,
        { senderId: senders[i], receiverId: 'u-de', payload: greetingPayload(senders[i]) },
        store.clock,
      );
      expect(prepared).not.toBeNull();
      if (prepared!.opts) await notifyUser('u-de', 't1', 'new_chat_message', prepared!.payload, sb, prepared!.opts);
      else await notifyUser('u-de', 't1', 'new_chat_message', prepared!.payload, sb);
      pushesAfter.push(pushCalls());
    }
    expect(store.rows).toHaveLength(5);
    // The push transport was used for the first greeting only.
    expect(pushesAfter[0]).toBeGreaterThan(0);
    expect(new Set(pushesAfter).size).toBe(1);
    const outcomes = store.rows.map((r) => r.push_outcome);
    expect(outcomes.filter((o) => o === 'coalesced')).toHaveLength(4);
    expect(outcomes.filter((o) => o && o.startsWith('delivered_'))).toHaveLength(1);
    expect(outcomes[0]).toMatch(/^delivered_/);
    // The bell stays complete: one row per greeter, each with its own sender title.
    expect(store.rows.map((r) => r.title)).toEqual(senders.map((s) => `Member ${s}`));
    expect(store.rows[4].data).toEqual(expect.objectContaining({ greeting_count: '5', push_coalesced: 'true' }));
  });

  test('c) after the window the next greeting pushes the localized summary (DE and EN)', async () => {
    for (const receiver of ['u-de', 'u-en']) {
      seedGreeting(receiver, 's0', NOW - 25 * HOUR, true);
      seedGreeting(receiver, 's1', NOW - 20 * HOUR, false);
      seedGreeting(receiver, 's2', NOW - 10 * HOUR, false);
      seedGreeting(receiver, 's3', NOW - 1 * HOUR, false);
    }
    const { sb } = fakeSupabase();
    const de1 = await prepareNewMemberGreetingPush(sb, { senderId: 's4', receiverId: 'u-de', payload: greetingPayload('s4') }, NOW);
    const en1 = await prepareNewMemberGreetingPush(sb, { senderId: 's4', receiverId: 'u-en', payload: greetingPayload('s4') }, NOW);
    expect(de1!.opts).toBeUndefined();
    expect(de1!.payload.title).toBe(tt('notif.new_member_greeting_burst.title', 'de'));
    expect(de1!.payload.body).toBe(tt('notif.new_member_greeting_burst.body', 'de', { count: 4 }));
    expect(de1!.payload.body).toBe('4 Leute haben dir Hallo gesagt 👋');
    expect(en1!.payload.title).toBe('Welcome to the community 👋');
    expect(en1!.payload.body).toBe('4 people said hello 👋');
    expect(de1!.payload.data!.greeting_count).toBe('4');
  });

  test('d) reading the greeting does not reset the window (unlike chat coalescing)', async () => {
    seedGreeting('u-en', 's1', NOW - 2 * HOUR, true, { read_at: iso(NOW - HOUR) });
    const { sb } = fakeSupabase();
    const p = await prepareNewMemberGreetingPush(sb, { senderId: 's2', receiverId: 'u-en', payload: greetingPayload('s2') }, NOW);
    expect(p!.opts).toEqual({ suppressPush: 'coalesced' });
  });

  test('e) the same sender twice counts once in {count}', async () => {
    seedGreeting('u-en', 's1', NOW - 5 * HOUR, false);
    seedGreeting('u-en', 's2', NOW - 4 * HOUR, false);
    seedGreeting('u-en', 's1', NOW - 3 * HOUR, false);
    const { sb } = fakeSupabase();
    const d = await decideGreetingPush(sb, 'u-en', 's1', NOW);
    expect(d).toEqual({ push: true, greeterCount: 2 });
    const p = await prepareNewMemberGreetingPush(sb, { senderId: 's1', receiverId: 'u-en', payload: greetingPayload('s1') }, NOW);
    expect(p!.payload.body).toBe('2 people said hello 👋');
  });

  test('a greeting pushed 23 h ago still holds; one pushed 25 h ago does not', async () => {
    seedGreeting('u-en', 's1', NOW - 23 * HOUR, true);
    const { sb } = fakeSupabase();
    expect((await decideGreetingPush(sb, 'u-en', 's2', NOW))!.push).toBe(false);
    // Two hours later that push is 25 h old.
    expect((await decideGreetingPush(sb, 'u-en', 's2', NOW + 2 * HOUR))!.push).toBe(true);
  });

  test('the greeting read is one query scoped to this receiver\'s greeting rows of the last 24 h', async () => {
    const { sb, calls } = fakeSupabase();
    await decideGreetingPush(sb, 'u-en', 's1', NOW);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['from', 'user_notifications'],
        ['eq', 'user_id', 'u-en'],
        ['in', 'type', ['new_chat_message']],
        ['eq', 'data->>greeting_group', 'new_member_greeting'],
        ['gte', 'created_at', iso(NOW - GREETING_PUSH_WINDOW_MS)],
      ]),
    );
    expect(calls.filter((c) => c[0] === 'is')).toEqual([]); // read state is not a filter
  });

  test('f) a greeting-window read error falls back to per-conversation coalescing', async () => {
    seedGreeting('u-en', 's9', NOW - HOUR, true);
    const { sb, calls } = fakeSupabase({ failGreetingRead: true });
    const p = await prepareNewMemberGreetingPush(sb, { senderId: 's1', receiverId: 'u-en', payload: greetingPayload('s1') }, NOW);
    expect(p!.opts).toBeUndefined(); // nothing unread in dm:s1 → pushes as before
    expect(p!.payload.tag).toBe('chat:dm:s1');
    expect(p!.payload.data).not.toHaveProperty('greeting_group');
    expect(calls).toEqual(expect.arrayContaining([['eq', 'data->>conversation_key', 'dm:s1']]));
  });

  test('g) NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED=false → per-conversation behaviour, no greeting read', async () => {
    process.env.NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED = 'false';
    seedGreeting('u-en', 's9', NOW - HOUR, true);
    const { sb, calls } = fakeSupabase();
    const p = await prepareNewMemberGreetingPush(sb, { senderId: 's1', receiverId: 'u-en', payload: greetingPayload('s1') }, NOW);
    expect(p!.opts).toBeUndefined();
    expect(p!.payload.tag).toBe('chat:dm:s1');
    expect(calls.some((c) => c[0] === 'eq' && c[1] === 'data->>greeting_group')).toBe(false);
    expect(calls).toEqual(expect.arrayContaining([['eq', 'data->>conversation_key', 'dm:s1']]));
  });

  describe('h) test/service accounts never receive or trigger a greeting notification', () => {
    for (const grouping of ['true', 'false']) {
      test.each([
        ['excluded sender', { ids: ['bot-1'] }, 'bot-1', 'u-en'],
        ['excluded receiver', { ids: ['bot-1'] }, 's1', 'bot-1'],
        ['exclusion lookup error (fail closed)', { error: true }, 's1', 'u-en'],
      ])(`%s → null, no notification read (grouping=${grouping})`, async (_label, exclusion, sender, receiver) => {
        process.env.NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED = grouping;
        const { sb, calls } = fakeSupabase({ exclusion: exclusion as Exclusion });
        const p = await prepareNewMemberGreetingPush(
          sb,
          { senderId: sender as string, receiverId: receiver as string, payload: greetingPayload(sender as string) },
          NOW,
        );
        expect(p).toBeNull();
        expect(calls).not.toEqual(expect.arrayContaining([['from', 'user_notifications']]));
      });
    }

    test('an excluded greeter writes no row, so it never inflates {count}', async () => {
      const { sb } = fakeSupabase({ exclusion: { ids: ['bot-1'] } });
      for (const s of ['s1', 'bot-1']) {
        const p = await prepareNewMemberGreetingPush(sb, { senderId: s, receiverId: 'u-en', payload: greetingPayload(s) }, NOW);
        if (p) await notifyUser('u-en', 't1', 'new_chat_message', p.payload, sb, p.opts);
      }
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0].data!.sender_id).toBe('s1');
    });
  });
});

describe('k) i18n: the greeting keys exist in every shipped locale', () => {
  const RAW: Record<string, Record<string, string>> = { de, en, es, sr, fr, pt, ru, pl, zh, ar, tr };
  const KEYS = ['notif.new_member_greeting_burst.title', 'notif.new_member_greeting_burst.body'] as const;

  test('all 11 locales are covered', () => {
    expect(Object.keys(RAW).sort()).toEqual([...GATEWAY_LOCALES].sort());
  });

  test.each([...GATEWAY_LOCALES])('%s has both keys, non-empty, {count} preserved, not English (except en)', (locale) => {
    for (const k of KEYS) {
      const v = RAW[locale][k];
      expect(typeof v).toBe('string');
      expect(v.trim()).not.toBe('');
      if (locale !== 'en') expect(v).not.toBe((en as Record<string, string>)[k]);
    }
    expect([...RAW[locale][KEYS[1]].matchAll(/\{(\w+)\}/g)].map((m) => m[1])).toEqual(['count']);
    expect(RAW[locale][KEYS[0]]).not.toMatch(/\{\w+\}/);
    expect(tt(KEYS[1], locale, { count: 7 })).toContain('7');
  });

  test('tt() serves the Arabic text for ar, not the English fallback', () => {
    expect(tt('notif.new_member_greeting_burst.title', 'ar')).toBe((ar as Record<string, string>)['notif.new_member_greeting_burst.title']);
    expect(tt('notif.new_member_greeting_burst.body', 'ar', { count: 3 })).not.toBe(tt('notif.new_member_greeting_burst.body', 'en', { count: 3 }));
  });

  test('du-form in German (no Sie/Ihr/Ihnen)', () => {
    for (const k of KEYS) expect((de as Record<string, string>)[k]).not.toMatch(/\b(Sie|Ihr|Ihnen|Ihre)\b/);
  });
});
