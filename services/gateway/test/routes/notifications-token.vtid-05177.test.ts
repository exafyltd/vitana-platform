/**
 * VTID-05177 — POST /api/v1/notifications/token: first coverage for the route.
 *
 * Today's web and Appilix bodies must produce exactly today's queries and
 * upsert row (no device_type / app_version keys). ios_native / android_native
 * store their type and version with a server-set label that can never match
 * the Appilix detectors in notification-service.ts. Takeover and prune are
 * unchanged.
 */
import express from 'express';
import request from 'supertest';
import { makeFakeSupabase, newHarnessState, normalise } from '../services/native-push-harness.vtid-05177';

const state = newHarnessState();

jest.mock('../../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../../src/middleware/auth-supabase-jwt');
  const setIdentity = (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'user-0000-aaaa', tenant_id: 'tenant-0000-1111' };
    next();
  };
  return { ...actual, requireAuth: setIdentity, requireTenant: (_req: any, _res: any, next: any) => next() };
});

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return { ...actual, createClient: () => (global as any).__vtid05177TokenSb() };
});

(global as any).__vtid05177TokenSb = () => makeFakeSupabase(state);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../src/routes/notifications').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveNativeDevice } = require('../../src/routes/notifications');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/notifications', router);
  return a;
}

const WEB_LABEL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0';
const APPILIX_LABEL = 'Appilix Mozilla/5.0 (Linux; Android; K) App10 AppleWebKit/537.36';
const APPILIX_DETECTORS = [/^Appilix /, /appilix|\bApp\d+\b/i];

let warn: jest.SpyInstance;
beforeEach(() => {
  state.events = [];
  state.tables = {};
  delete process.env.NATIVE_PUSH_DIRECT_ENABLED;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

async function register(body: Record<string, unknown>) {
  const res = await request(app()).post('/api/v1/notifications/token').send(body);
  return { res, events: normalise(state.events) };
}

const upsertRow = (events: any[]) => events.find((e) => e.ops[0][0] === 'upsert').ops[0][1];

/** The exact three queries the route made before VTID-05177, for a given body. */
function expectedLegacyEvents(fcm_token: string, device_label: string | null) {
  return [
    {
      kind: 'db', table: 'user_device_tokens',
      ops: [
        ['update', { revoked_at: '<ts>', revoked_reason: 'taken_over' }],
        ['eq', 'fcm_token', fcm_token],
        ['neq', 'user_id', 'user-0000-aaaa'],
        ['is', 'revoked_at', null],
      ],
    },
    {
      kind: 'db', table: 'user_device_tokens',
      ops: [
        ['upsert', {
          user_id: 'user-0000-aaaa', tenant_id: 'tenant-0000-1111', fcm_token, device_label,
          updated_at: '<ts>', revoked_at: null, revoked_reason: null,
        }, { onConflict: 'user_id,fcm_token' }],
      ],
    },
    {
      kind: 'db', table: 'user_device_tokens',
      ops: [
        ['update', { revoked_at: '<ts>', revoked_reason: 'stale' }],
        ['eq', 'user_id', 'user-0000-aaaa'],
        ['neq', 'fcm_token', fcm_token],
        ['lt', 'updated_at', '<ts>'],
        ['is', 'revoked_at', null],
      ],
    },
  ];
}

describe('POST /notifications/token — today\'s clients are unchanged', () => {
  it('web body (fcm_token + browser UA label) → today\'s takeover, upsert and prune, no device_type key', async () => {
    const { res, events } = await register({ fcm_token: 'tok-web', device_label: WEB_LABEL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(events).toEqual(expectedLegacyEvents('tok-web', WEB_LABEL));
    expect(upsertRow(events)).not.toHaveProperty('device_type');
    expect(upsertRow(events)).not.toHaveProperty('app_version');
  });

  it('Appilix body (device_type "appilix" + package_name) → identical row, device_type ignored', async () => {
    const { events } = await register({
      fcm_token: 'tok-app', device_label: APPILIX_LABEL, device_type: 'appilix', package_name: 'com.vitanaland.app',
    });
    expect(events).toEqual(expectedLegacyEvents('tok-app', APPILIX_LABEL));
  });

  it('a missing label is stored as null, as today', async () => {
    const { events } = await register({ fcm_token: 'tok-x' });
    expect(upsertRow(events).device_label).toBeNull();
  });

  it('missing fcm_token is still 400', async () => {
    const { res, events } = await register({ device_type: 'ios_native' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'fcm_token is required' });
    expect(events).toEqual([]);
  });

  it.each(['IOS_NATIVE', 'ios', 'android', 'web', 'native', 42, null])('device_type %p is ignored', async (dt) => {
    const { events } = await register({ fcm_token: 'tok-web', device_label: WEB_LABEL, device_type: dt, app_version: '1.0.0' });
    expect(events).toEqual(expectedLegacyEvents('tok-web', WEB_LABEL));
  });
});

describe('POST /notifications/token — native app tokens', () => {
  it.each([
    ['ios_native', 'native-ios 1.2.3'],
    ['android_native', 'native-android 1.2.3'],
  ])('%s stores its type, version and a server-set label', async (deviceType, label) => {
    const { res, events } = await register({
      fcm_token: 'tok-n', device_label: APPILIX_LABEL, device_type: deviceType, app_version: '1.2.3',
    });
    expect(res.status).toBe(200);
    const row = upsertRow(events);
    expect(row).toEqual({
      user_id: 'user-0000-aaaa', tenant_id: 'tenant-0000-1111', fcm_token: 'tok-n',
      device_label: label, updated_at: '<ts>', device_type: deviceType, app_version: '1.2.3',
      revoked_at: null, revoked_reason: null,
    });
    for (const re of APPILIX_DETECTORS) expect(re.test(row.device_label)).toBe(false);
    // takeover and prune are unchanged
    const legacy = expectedLegacyEvents('tok-n', label);
    expect(events[0]).toEqual(legacy[0]);
    expect(events[2]).toEqual(legacy[2]);
    expect(events).toHaveLength(3);
  });

  it.each(['1.2.3 beta', 'x'.repeat(33), '1.0/2', '', 7])('a bad app_version %p is dropped', async (v) => {
    const { events } = await register({ fcm_token: 'tok-n', device_type: 'ios_native', app_version: v });
    const row = upsertRow(events);
    expect(row.app_version).toBeNull();
    expect(row.device_label).toBe('native-ios');
    for (const re of APPILIX_DETECTORS) expect(re.test(row.device_label)).toBe(false);
  });

  it('accepts a 32-character version of [0-9A-Za-z.+-]', () => {
    const v = '1.0.0-rc.1+build.' + '9'.repeat(15);
    expect(v).toHaveLength(32);
    expect(resolveNativeDevice('android_native', v)).toEqual({
      device_type: 'android_native', app_version: v, device_label: `native-android ${v}`,
    });
  });

  it('warns when a native token arrives while NATIVE_PUSH_DIRECT_ENABLED is off, not when on', async () => {
    await register({ fcm_token: 'tok-n', device_type: 'ios_native', app_version: '1.0.0' });
    expect(warn).toHaveBeenCalledWith('[Notifications] native token registered while NATIVE_PUSH_DIRECT_ENABLED is off');
    warn.mockClear();
    process.env.NATIVE_PUSH_DIRECT_ENABLED = 'true';
    await register({ fcm_token: 'tok-n', device_type: 'ios_native', app_version: '1.0.0' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockClear();
    delete process.env.NATIVE_PUSH_DIRECT_ENABLED;
    await register({ fcm_token: 'tok-web', device_label: WEB_LABEL });
    expect(warn).not.toHaveBeenCalled();
  });
});
