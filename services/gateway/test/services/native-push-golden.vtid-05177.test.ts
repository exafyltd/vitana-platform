/**
 * VTID-05177 — switch-off golden fixtures for the three push dispatch sites.
 *
 * Recorded from the UNMODIFIED dispatch code at origin/main d577b319d, before
 * any native-push routing change. With NATIVE_PUSH_DIRECT_ENABLED and
 * NATIVE_PUSH_APPILIX_GUARD_ENABLED unset, every site must keep making exactly
 * these calls — the same Supabase queries (table, method chain, arguments),
 * the same FCM messages, the same Appilix requests, the same OASIS events and
 * the same result — in the same order, for every token mix.
 *
 * Sites (plan F4):
 *   (a) notifyUser                         — services/notification-service.ts
 *   (b) POST /push-dispatch                — routes/scheduled-notifications.ts
 *   (c) scheduleReminderFcmPush            — services/reminders-dispatch.ts
 *
 * The fixture file is never regenerated in the PR that changes dispatch code.
 * To record it (only ever against unchanged dispatch code):
 *   RECORD_PUSH_GOLDEN=1 npx jest test/services/native-push-golden.vtid-05177.test.ts
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  HarnessState,
  allScenarios,
  makeAppilixFetch,
  makeFakeSupabase,
  makeFcmSend,
  newHarnessState,
  normalise,
  pushPayload,
  seedState,
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
const scheduledRouter = require('../../src/routes/scheduled-notifications').default;
/* eslint-enable @typescript-eslint/no-var-requires */

const GOLDEN_PATH = path.join(__dirname, '__golden__', 'vtid-05177-push-switch-off.json');

const ENV_KEYS = ['NATIVE_PUSH_DIRECT_ENABLED', 'NATIVE_PUSH_APPILIX_GUARD_ENABLED'] as const;

const savedFetch = global.fetch;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ['APPILIX_APP_KEY', 'APPILIX_API_KEY', 'APPILIX_IOS_APP_KEY', 'APPILIX_IOS_API_KEY', 'APPILIX_APP_URL', ...ENV_KEYS]) {
    savedEnv[k] = process.env[k];
  }
  process.env.APPILIX_APP_KEY = 'and-app-key';
  process.env.APPILIX_API_KEY = 'and-api-key';
  process.env.APPILIX_IOS_APP_KEY = 'ios-app-key';
  process.env.APPILIX_IOS_API_KEY = 'ios-api-key';
  delete process.env.APPILIX_APP_URL;
  for (const k of ENV_KEYS) delete process.env[k];
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
  currentSupabase = makeFakeSupabase(state);
});

type SiteName = 'notifyUser' | 'push-dispatch' | 'reminder';

async function runSite(site: SiteName, withUrl: boolean): Promise<any> {
  const payload = pushPayload(withUrl);
  if (site === 'notifyUser') {
    return notifyUser(USER, TENANT, 'post_like', payload, currentSupabase);
  }
  if (site === 'push-dispatch') {
    state.tables.user_notifications = [
      {
        id: 'notif-1',
        user_id: USER,
        tenant_id: TENANT,
        type: 'post_like',
        title: payload.title,
        body: payload.body,
        data: payload.data,
        channel: 'push_and_inapp',
        priority: 'p1',
        created_at: new Date().toISOString(),
        push_sent_at: null,
      },
    ];
    const app = express();
    app.use(express.json());
    app.use('/api/v1/scheduled-notifications', scheduledRouter);
    const res = await request(app).post('/api/v1/scheduled-notifications/push-dispatch').send({});
    return { status: res.status, body: res.body };
  }
  // reminder: the URL is fixed by the function itself; withUrl is not used.
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = (fn: () => void) => { fn(); return 0 as any; };
  try {
    return await scheduleReminderFcmPush(currentSupabase, {
      id: 'rem-1',
      user_id: USER,
      tenant_id: TENANT,
      action_text: 'Drink water',
      spoken_message: null,
    });
  } finally {
    (global as any).setTimeout = realSetTimeout;
  }
}

const SITES: SiteName[] = ['notifyUser', 'push-dispatch', 'reminder'];

async function recordAll(): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const site of SITES) {
    for (const s of allScenarios()) {
      if (site === 'reminder' && !s.withUrl) continue; // reminders always carry a URL
      seedState(state, s);
      currentSupabase = makeFakeSupabase(state);
      const result = await runSite(site, s.withUrl);
      out[`${site}|${s.key}`] = normalise({ result: result ?? null, events: state.events });
    }
  }
  return out;
}

describe('VTID-05177 switch-off golden fixtures (all three dispatch sites)', () => {
  it('every site makes exactly the recorded calls with both native switches unset', async () => {
    const actual = await recordAll();
    if (process.env.RECORD_PUSH_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      // One scenario per line: compact, and a diff names the scenario that moved.
      const lines = Object.keys(actual).map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(actual[k])}`);
      fs.writeFileSync(GOLDEN_PATH, `{\n${lines.join(',\n')}\n}\n`);
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
    for (const key of Object.keys(golden)) {
      expect({ key, ...actual[key] }).toEqual({ key, ...golden[key] });
    }
  });

  it('the fixture covers the cases that matter (sanity on the recording itself)', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    const keys = Object.keys(golden);
    expect(keys.length).toBeGreaterThanOrEqual(100);
    // URL push to a web+Appilix user: Appilix first, FCM fallback excludes the Appilix token.
    const ev = golden['notifyUser|web+appilix|url|appilix-no_device'].events;
    const fcmTokens = ev.filter((e: any) => e.kind === 'fcm').map((e: any) => e.message.token);
    expect(fcmTokens).toEqual(['tok-web']);
    expect(ev.filter((e: any) => e.kind === 'appilix')).toHaveLength(2);
    // F4b asymmetry: push-dispatch's URL fallback does NOT exclude Appilix tokens.
    const ev2 = golden['push-dispatch|web+appilix|url|appilix-no_device'].events;
    expect(ev2.filter((e: any) => e.kind === 'fcm').map((e: any) => e.message.token).sort()).toEqual(['tok-app', 'tok-web']);
    // No FCM message today carries an APNs badge.
    for (const k of keys) {
      for (const e of golden[k].events) {
        if (e.kind === 'fcm') expect(e.message?.apns?.payload).toBeUndefined();
      }
    }
  });
});
