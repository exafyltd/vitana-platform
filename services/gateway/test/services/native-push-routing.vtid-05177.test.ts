/**
 * VTID-05177 — native push routing (plan Changes 5–7), table-driven over the
 * three dispatch sites (notifyUser, POST /push-dispatch, reminders) and the
 * token mixes in native-push-harness.vtid-05177.ts.
 *
 * Switch off is pinned by native-push-golden.vtid-05177.test.ts (recorded from
 * the unmodified code). This suite covers:
 *   - switch on: native pass first, legacy behaviour unchanged over legacy
 *     tokens, zero-send fallbacks count legacy sends only, stale native tokens
 *     revoked, iOS badge rules;
 *   - the duplicate guard: inactive unless BOTH switches are on (R2-F9);
 *   - a mistyped switch value is off.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  HarnessState,
  TOKEN_MIXES,
  allScenarios,
  makeAppilixFetch,
  makeFakeSupabase,
  makeFcmSend,
  newHarnessState,
  normalise,
  pushPayload,
  seedState,
  Scenario,
  USER,
  TENANT,
} from './native-push-harness.vtid-05177';

const state: HarnessState = newHarnessState();
let currentSupabase: any = makeFakeSupabase(state);

jest.mock('firebase-admin', () => {
  const send = (msg: any) => (global as any).__vtid05177Send(msg);
  return {
    apps: [],
    initializeApp: jest.fn(),
    credential: { applicationDefault: jest.fn() },
    messaging: () => ({ send }),
  };
});

jest.mock('../../src/services/notification-controls/notification-controls-service', () => {
  const actual = jest.requireActual('../../src/services/notification-controls/notification-controls-service');
  return {
    ...actual,
    isNotificationTypeAllowed: jest.fn(async () => true),
    isMemberCategoryAllowed: jest.fn(async () => true),
    isMemberInQuietHours: jest.fn(async () => false),
    recordNotificationBlock: jest.fn(),
    decidePushDelivery: jest.fn(async () => ({ send: true })),
  };
});

jest.mock('../../src/services/jev/gates/community-ranking-gates', () => ({
  shadowNotificationWorth: jest.fn(async () => undefined),
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../../src/middleware/auth-supabase-jwt');
  return { ...actual, resolveVitanaId: jest.fn(async () => null) };
});

jest.mock('../../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn(async () => 'en'),
  bulkGetUserLocales: jest.fn(async () => new Map()),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (ev: any) => {
    (global as any).__vtid05177State.events.push({ kind: 'oasis', event: JSON.parse(JSON.stringify(ev)) });
    return { ok: true };
  }),
}));

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return { ...actual, createClient: () => (global as any).__vtid05177Supabase() };
});

(global as any).__vtid05177State = state;
(global as any).__vtid05177Supabase = () => currentSupabase;
(global as any).__vtid05177Send = makeFcmSend(() => state);

/* eslint-disable @typescript-eslint/no-var-requires */
const { notifyUser } = require('../../src/services/notification-service');
const { scheduleReminderFcmPush } = require('../../src/services/reminders-dispatch');
const { hasOnlyNativeAppDevices } = require('../../src/services/push-routing');
const scheduledRouter = require('../../src/routes/scheduled-notifications').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const GOLDEN_PATH = path.join(__dirname, '__golden__', 'vtid-05177-push-switch-off.json');
const NATIVE_TOKENS = new Set(['tok-ios', 'tok-and']);

type SiteName = 'notifyUser' | 'push-dispatch' | 'reminder';
const SITES: SiteName[] = ['notifyUser', 'push-dispatch', 'reminder'];

const savedFetch = global.fetch;
const ENV_KEYS = [
  'APPILIX_APP_KEY', 'APPILIX_API_KEY', 'APPILIX_IOS_APP_KEY', 'APPILIX_IOS_API_KEY', 'APPILIX_APP_URL',
  'NATIVE_PUSH_DIRECT_ENABLED', 'NATIVE_PUSH_APPILIX_GUARD_ENABLED',
];
const savedEnv: Record<string, string | undefined> = {};

function setSwitches(direct?: string, guard?: string) {
  if (direct === undefined) delete process.env.NATIVE_PUSH_DIRECT_ENABLED;
  else process.env.NATIVE_PUSH_DIRECT_ENABLED = direct;
  if (guard === undefined) delete process.env.NATIVE_PUSH_APPILIX_GUARD_ENABLED;
  else process.env.NATIVE_PUSH_APPILIX_GUARD_ENABLED = guard;
}

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.APPILIX_APP_KEY = 'and-app-key';
  process.env.APPILIX_API_KEY = 'and-api-key';
  process.env.APPILIX_IOS_APP_KEY = 'ios-app-key';
  process.env.APPILIX_IOS_API_KEY = 'ios-api-key';
  delete process.env.APPILIX_APP_URL;
});

// The global setup (test/__mocks__/setup-tests.ts) calls jest.restoreAllMocks()
// after every test, so console spies installed once in beforeAll only silence
// the first test. Re-install them per test: the dispatch paths log every
// FCM/Appilix call, and unsilenced they print ~1.6 MB, which overflows the
// STAGING-VERIFY runner's spawnSync buffer and kills the run before Jest's
// summary (VTID-05177 staging verify @2dc187f86).
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  global.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  global.fetch = makeAppilixFetch(() => state) as any;
  setSwitches(undefined, undefined);
});

async function runSite(site: SiteName, withUrl: boolean): Promise<any> {
  const payload = pushPayload(withUrl);
  if (site === 'notifyUser') {
    return notifyUser(USER, TENANT, 'post_like', payload, currentSupabase);
  }
  if (site === 'push-dispatch') {
    state.tables.user_notifications = [
      ...(state.tables.user_notifications || []),
      {
        id: 'notif-1', user_id: USER, tenant_id: TENANT, type: 'post_like',
        title: payload.title, body: payload.body, data: payload.data,
        channel: 'push_and_inapp', priority: 'p1', created_at: new Date().toISOString(), push_sent_at: null,
      },
    ];
    const app = express();
    app.use(express.json());
    app.use('/api/v1/scheduled-notifications', scheduledRouter);
    const res = await request(app).post('/api/v1/scheduled-notifications/push-dispatch').send({});
    return { status: res.status, body: res.body };
  }
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = (fn: () => void) => { fn(); return 0 as any; };
  try {
    return await scheduleReminderFcmPush(currentSupabase, {
      id: 'rem-1', user_id: USER, tenant_id: TENANT, action_text: 'Drink water', spoken_message: null,
    });
  } finally {
    (global as any).setTimeout = realSetTimeout;
  }
}

async function run(site: SiteName, s: Scenario, extra?: (st: HarnessState) => void) {
  seedState(state, s);
  if (extra) extra(state);
  currentSupabase = makeFakeSupabase(state);
  const result = await runSite(site, s.withUrl);
  return { result, events: state.events.slice() };
}

const scenario = (mixName: string, withUrl: boolean, appilix: 'delivered' | 'no_device' = 'no_device'): Scenario => {
  const mix = TOKEN_MIXES.find((m) => m.name === mixName)!;
  return { key: `${mixName}|${withUrl}|${appilix}`, mix, withUrl, appilix };
};

const fcmTokens = (events: any[]) => events.filter((e) => e.kind === 'fcm').map((e) => e.message.token);
const appilixCalls = (events: any[]) => events.filter((e) => e.kind === 'appilix');
const isCountUnread = (e: any) =>
  e.kind === 'db' && e.table === 'user_notifications' && e.ops.some((o: any) => o[0] === 'is' && o[1] === 'read_at');
const isDeviceTypeQuery = (e: any) =>
  e.kind === 'db' && e.table === 'user_device_tokens' && e.ops[0]?.[0] === 'select' && String(e.ops[0][1]).includes('device_type');

/**
 * Strip the native pass from a switch-on recording so it can be compared with
 * a switch-off run over the legacy tokens only.
 */
function legacyView(events: any[]): any[] {
  const out: any[] = [];
  let nativeFetchDropped = false;
  for (const e of events) {
    if (e.kind === 'fcm' && NATIVE_TOKENS.has(e.message.token)) continue;
    if (isCountUnread(e)) continue;
    if (
      e.kind === 'db' && e.table === 'user_device_tokens' && e.ops[0]?.[0] === 'update' &&
      e.ops.some((o: any) => o[0] === 'eq' && o[1] === 'fcm_token' && NATIVE_TOKENS.has(o[2]))
    ) continue;
    if (isDeviceTypeQuery(e) && e.ops[0][1] === 'fcm_token, device_label, device_type') {
      if (!nativeFetchDropped) { nativeFetchDropped = true; continue; }
      out.push({ ...e, ops: [['select', 'fcm_token, device_label'], ...e.ops.slice(1)] });
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * Bookkeeping that legitimately reflects the native sends too: push_outcome,
 * and the reminder's delivered marker + OASIS event (written when any push,
 * native included, went out). Asserted separately below.
 */
function maskOutcome(events: any[]): any[] {
  return events
    .filter((e) => !(e.kind === 'oasis') && !(e.kind === 'db' && e.table === 'reminders'))
    .map((e) => {
    if (e.kind === 'db' && e.ops[0]?.[0] === 'update' && e.ops[0][1] && 'push_outcome' in e.ops[0][1]) {
      return { ...e, ops: [['update', { push_outcome: '<outcome>' }], ...e.ops.slice(1)] };
    }
    if (e.kind === 'oasis' && e.event?.payload && 'fcm_devices' in e.event.payload) {
      return { ...e, event: { ...e.event, payload: { ...e.event.payload, fcm_devices: '<n>' } } };
    }
    return e;
  });
}

describe('switch ON (NATIVE_PUSH_DIRECT_ENABLED=true)', () => {
  beforeEach(() => setSwitches('true', undefined));

  it.each(SITES)('%s: native tokens always go straight to FCM, with and without a URL, whatever Appilix does', async (site) => {
    for (const withUrl of [true, false]) {
      for (const appilix of ['delivered', 'no_device'] as const) {
        const { events } = await run(site, scenario('native-ios+appilix+web', withUrl, appilix));
        expect(fcmTokens(events)).toContain('tok-ios');
        const { events: e2 } = await run(site, scenario('native-ios+native-android', withUrl, appilix));
        expect(fcmTokens(e2)).toEqual(expect.arrayContaining(['tok-ios', 'tok-and']));
      }
    }
  });

  it.each(SITES)('%s: the native pass runs first', async (site) => {
    const { events } = await run(site, scenario('native-ios+appilix+web', true, 'delivered'));
    const firstPush = events.findIndex((e: any) => e.kind === 'fcm' || e.kind === 'appilix');
    expect(events[firstPush].kind).toBe('fcm');
    expect(events[firstPush].message.token).toBe('tok-ios');
  });

  it('legacy behaviour over legacy tokens equals the switch-off behaviour, for every site and mix', async () => {
    let compared = 0;
    for (const site of SITES) {
      for (const s of allScenarios()) {
        if (site === 'reminder' && !s.withUrl) continue;
        // Reminders read the Appilix suppression AFTER the FCM sends, as they
        // always did; a stale native token revoked by the native pass is
        // therefore visible to it (asserted separately below).
        if (site === 'reminder' && s.mix.name === 'native-ios-stale') continue;
        setSwitches('true', undefined);
        const on = await run(site, s);
        // Same scenario with the native rows removed, switch off.
        const legacyOnly: Scenario = { ...s, mix: { ...s.mix, rows: s.mix.rows.filter((r) => !r.device_type) } };
        setSwitches(undefined, undefined);
        const off = await run(site, legacyOnly);
        // push_outcome legitimately differs (the native sends count in the
        // same tally); everything else must match call for call.
        expect({ key: `${site}|${s.key}`, events: maskOutcome(normalise(legacyView(on.events))) })
          .toEqual({ key: `${site}|${s.key}`, events: maskOutcome(normalise(off.events)) });
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(100);
  });

  it.each(['notifyUser', 'push-dispatch'] as SiteName[])(
    '%s: a native send does not hide a missing Appilix delivery (no-URL fallback counts legacy sends only)',
    async (site) => {
      const { result, events } = await run(site, scenario('native-ios', false, 'delivered'));
      expect(fcmTokens(events)).toEqual(['tok-ios']);
      expect(appilixCalls(events)).toHaveLength(2); // both platforms tried
      if (site === 'notifyUser') expect(result).toMatchObject({ pushed: 1 });
    },
  );

  it('reminder: the "FCM reached zero" Appilix fallback counts legacy sends only', async () => {
    // Appilix-tagged token exists (so the first Appilix branch is skipped) but
    // its FCM send fails; the native send succeeds. Appilix must still be tried.
    const s = scenario('native-ios+appilix+web', true, 'delivered');
    const { events } = await run('reminder', s, (st) => {
      st.fcm['tok-app'] = 'error';
      st.fcm['tok-web'] = 'error';
    });
    expect(fcmTokens(events)).toEqual(['tok-ios', 'tok-app', 'tok-web']);
    expect(appilixCalls(events).length).toBeGreaterThan(0);
  });

  it('suppression is read at the same point relative to the FCM sends as before', async () => {
    // deep-link sites: before any FCM send, so revoking a stale native token
    // cannot flip this push's Appilix decision.
    const nu = await run('notifyUser', scenario('native-ios-stale', true, 'delivered'));
    expect(appilixCalls(nu.events)).toHaveLength(2);
    // reminders: after the FCM sends (native pass included) — the user's only
    // device just proved dead, so they are signed out on every known device.
    const rem = await run('reminder', scenario('native-ios-stale', true, 'delivered'));
    expect(appilixCalls(rem.events)).toHaveLength(0);
  });

  it('reminder: a reminder delivered only to a native token is marked delivered and counted', async () => {
    const { events } = await run('reminder', scenario('native-ios', true, 'no_device'));
    expect(events.some((e: any) => e.kind === 'db' && e.table === 'reminders' && e.ops[0][1]?.delivery_via === 'fcm')).toBe(true);
    const oasis = events.find((e: any) => e.kind === 'oasis');
    expect(oasis.event.payload).toMatchObject({ fcm_devices: 1, appilix_sent: false });
  });

  it.each(SITES)('%s: a stale native token is revoked', async (site) => {
    const { events } = await run(site, scenario('native-ios-stale', true));
    const revoke = events.find((e: any) =>
      e.kind === 'db' && e.table === 'user_device_tokens' && e.ops[0][0] === 'update' &&
      e.ops.some((o: any) => o[0] === 'eq' && o[1] === 'fcm_token' && o[2] === 'tok-ios'));
    expect(revoke).toBeDefined();
    expect(revoke.ops[0][1]).toMatchObject({ revoked_reason: 'fcm_invalid' });
  });

  describe('badge (notifyUser only, ios_native only)', () => {
    const seedUnread = (n: number) => (st: HarnessState) => {
      st.tables.user_notifications = Array.from({ length: n }, (_, i) => ({
        id: `old-${i}`, user_id: USER, tenant_id: TENANT, read_at: null,
      }));
    };

    it('sets aps.badge on the ios_native send only, from one unread count', async () => {
      const { events } = await run('notifyUser', scenario('native-ios+native-android', true), seedUnread(4));
      const ios = events.find((e: any) => e.kind === 'fcm' && e.message.token === 'tok-ios');
      const and = events.find((e: any) => e.kind === 'fcm' && e.message.token === 'tok-and');
      // 4 seeded unread + the row this notifyUser call just wrote.
      expect(ios.message.apns.payload.aps.badge).toBe(5);
      expect(ios.message.apns.headers['apns-collapse-id']).toBe('post_like:p-1');
      expect(and.message.apns?.payload).toBeUndefined();
      expect(events.filter(isCountUnread)).toHaveLength(1);
    });

    it('reads the count once per recipient with an ios_native token, never for others', async () => {
      for (const mix of TOKEN_MIXES) {
        const { events } = await run('notifyUser', scenario(mix.name, true), seedUnread(2));
        const hasIos = mix.rows.some((r) => r.device_type === 'ios_native' && r.revoked_at === null && r.user_id === USER);
        expect({ mix: mix.name, counts: events.filter(isCountUnread).length }).toEqual({ mix: mix.name, counts: hasIos ? 1 : 0 });
      }
    });

    it('leaves the badge out when the count read fails', async () => {
      const { events } = await run('notifyUser', scenario('native-ios', true), (st) => {
        st.failTables.add('user_notifications');
      });
      const ios = events.find((e: any) => e.kind === 'fcm' && e.message.token === 'tok-ios');
      expect(ios).toBeDefined();
      expect(ios.message.apns?.payload).toBeUndefined();
    });

    it.each(['push-dispatch', 'reminder'] as SiteName[])('%s (cron path) sends no badge and reads no count', async (site) => {
      const { events } = await run(site, scenario('native-ios+native-android', true), seedUnread(3));
      for (const e of events) if (e.kind === 'fcm') expect(e.message.apns?.payload).toBeUndefined();
      expect(events.filter(isCountUnread)).toHaveLength(0);
    });
  });

  describe('duplicate guard (NATIVE_PUSH_APPILIX_GUARD_ENABLED)', () => {
    it.each(SITES)('%s: guard switch off → Appilix is not suppressed for a native-only user', async (site) => {
      const { events } = await run(site, scenario('native-ios', true, 'delivered'));
      expect(appilixCalls(events).length).toBeGreaterThan(0);
      expect(events.some((e: any) => e.kind === 'db' && e.ops[0]?.[1] === 'device_type, device_label')).toBe(false);
    });

    it.each(SITES)('%s: guard on → Appilix suppressed only with native tokens and no "Appilix %" token', async (site) => {
      setSwitches('true', 'true');
      for (const withUrl of [true, false]) {
        const nativeOnly = await run(site, scenario('native-ios', withUrl, 'delivered'));
        expect(appilixCalls(nativeOnly.events)).toHaveLength(0);
        expect(fcmTokens(nativeOnly.events)).toContain('tok-ios');
      }
      const nativeOnly = await run(site, scenario('native-ios', true, 'delivered'));
      expect(fcmTokens(nativeOnly.events)).toContain('tok-ios');

      // With an "Appilix %" token, or no native token, the guard does not
      // fire: Appilix calls are exactly those made with the guard off.
      for (const mix of ['native-ios+appilix+web', 'web', 'appilix', 'none']) {
        for (const withUrl of [true, false]) {
          setSwitches('true', 'true');
          const guarded = await run(site, scenario(mix, withUrl, 'delivered'));
          setSwitches('true', undefined);
          const unguarded = await run(site, scenario(mix, withUrl, 'delivered'));
          expect({ mix, withUrl, n: appilixCalls(guarded.events).length })
            .toEqual({ mix, withUrl, n: appilixCalls(unguarded.events).length });
        }
      }
    });
  });
});

describe('switches that must leave today\'s behaviour untouched', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  async function expectGolden() {
    for (const site of SITES) {
      for (const s of allScenarios()) {
        if (site === 'reminder' && !s.withUrl) continue;
        const { result, events } = await run(site, s);
        const key = `${site}|${s.key}`;
        expect({ key, ...normalise({ result: result ?? null, events }) }).toEqual({ key, ...golden[key] });
      }
    }
  }

  it('guard on + routing off + native token present → Appilix not suppressed (R2-F9): every golden holds', async () => {
    setSwitches(undefined, 'true');
    await expectGolden();
  });

  it('a mistyped switch value ("TRUE", "1") is off: every golden holds', async () => {
    setSwitches('TRUE', '1');
    await expectGolden();
  });

  it('hasOnlyNativeAppDevices short-circuits to false (no query) unless direct routing is on', async () => {
    setSwitches(undefined, 'true');
    seedState(state, scenario('native-ios', true));
    currentSupabase = makeFakeSupabase(state);
    await expect(hasOnlyNativeAppDevices(USER, currentSupabase)).resolves.toBe(false);
    expect(state.events).toHaveLength(0);
  });
});
