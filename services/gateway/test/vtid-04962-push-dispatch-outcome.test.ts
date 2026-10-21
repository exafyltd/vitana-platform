// VTID-04962 — POST /push-dispatch records what happened to every row.
//
// push_sent_at stays the "handled" marker and is written FIRST, on its own,
// so a failed outcome write (e.g. the column not migrated yet) can never
// leave a row to be pushed again. The outcome is written after it.

import express from 'express';
import request from 'supertest';

const sendPushToUser = jest.fn();
const sendAppilixPush = jest.fn();
const recordPushOutcome = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/services/notification-service', () => {
  // The pure helpers are real; only I/O is mocked.
  const newPushFanoutOutcome = () => ({ sent: 0, stale: 0, errors: 0 });
  const classifyPushOutcome = (fcm: any, appilix: boolean) => {
    if (fcm.sent > 0 && appilix) return 'delivered_both';
    if (fcm.sent > 0) return 'delivered_fcm';
    if (appilix) return 'delivered_appilix';
    if (fcm.errors > 0) return 'fcm_error';
    return 'no_device';
  };
  return {
    notifyUser: jest.fn(),
    notifyUserAsync: jest.fn(),
    sendPushToUser: (...a: any[]) => sendPushToUser(...a),
    sendAppilixPush: (...a: any[]) => sendAppilixPush(...a),
    isSignedOutOnAllKnownDevices: jest.fn().mockResolvedValue(false),
    TYPE_META: {},
    newPushFanoutOutcome,
    classifyPushOutcome,
    recordPushOutcome: (...a: any[]) => recordPushOutcome(...a),
  };
});

const controls = {
  isNotificationTypeAllowed: jest.fn().mockResolvedValue(true),
  isMemberInQuietHours: jest.fn().mockResolvedValue(false),
  normalizeSourceKey: (s: unknown) => (typeof s === 'string' ? s : ''),
};
jest.mock('../src/services/notification-controls/notification-controls-service', () => controls);

const order: string[] = [];
const repoMock = {
  fetchPendingPushNotifications: jest.fn(),
  fetchUserNotificationPreferences: jest.fn().mockResolvedValue({ data: null, error: null }),
  markNotificationPushSent: jest.fn(async (_sb: any, id: string) => {
    order.push(`sent_at:${id}`);
    return { error: null };
  }),
};
jest.mock('../src/routes/scheduled-notifications-repository', () => ({
  ...jest.requireActual('../src/routes/scheduled-notifications-repository'),
  ...repoMock,
}));

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/scheduled-notifications').default;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/scheduled-notifications', router);
  return a;
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, user_id: `u-${id}`, tenant_id: 't1', type: 'community_post_published', title: 'T', body: 'B',
  data: {}, channel: 'push_and_inapp', priority: 'p2', created_at: new Date().toISOString(), ...extra,
});

async function dispatch(rows: any[]) {
  repoMock.fetchPendingPushNotifications.mockResolvedValue({ data: rows, error: null });
  return request(app()).post('/api/v1/scheduled-notifications/push-dispatch').send({});
}

const outcomeFor = (id: string) => recordPushOutcome.mock.calls.find((c) => c[1] === id)?.[2];

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  recordPushOutcome.mockImplementation(async (_sb: any, id: string) => { order.push(`outcome:${id}`); });
  controls.isNotificationTypeAllowed.mockResolvedValue(true);
  controls.isMemberInQuietHours.mockResolvedValue(false);
  repoMock.fetchUserNotificationPreferences.mockResolvedValue({ data: null, error: null });
});

test('FCM errors only (no URL) → Appilix fallback fires; outcome delivered_appilix', async () => {
  sendPushToUser.mockImplementation(async (_u: any, _t: any, _p: any, _s: any, opts: any) => {
    opts.outcome.errors += 1;
    return 0;
  });
  sendAppilixPush.mockResolvedValue(true);
  const res = await dispatch([row('a')]);
  expect(res.body).toEqual(expect.objectContaining({ dispatched: 1 }));
  expect(sendAppilixPush).toHaveBeenCalledTimes(1);
  expect(outcomeFor('a')).toBe('delivered_appilix');
});

test('FCM errors and Appilix reaches nobody → fcm_error', async () => {
  sendPushToUser.mockImplementation(async (_u: any, _t: any, _p: any, _s: any, opts: any) => {
    opts.outcome.errors += 1;
    return 0;
  });
  sendAppilixPush.mockResolvedValue(false);
  await dispatch([row('b')]);
  expect(outcomeFor('b')).toBe('fcm_error');
});

test('FCM delivers → delivered_fcm, no Appilix', async () => {
  sendPushToUser.mockImplementation(async (_u: any, _t: any, _p: any, _s: any, opts: any) => {
    opts.outcome.sent += 1;
    return 1;
  });
  await dispatch([row('c')]);
  expect(sendAppilixPush).not.toHaveBeenCalled();
  expect(outcomeFor('c')).toBe('delivered_fcm');
});

test('no device → no_device', async () => {
  sendPushToUser.mockResolvedValue(0);
  sendAppilixPush.mockResolvedValue(false);
  await dispatch([row('d')]);
  expect(outcomeFor('d')).toBe('no_device');
});

test('deep link: Appilix first, delivered_appilix', async () => {
  sendAppilixPush.mockResolvedValue(true);
  await dispatch([row('e', { data: { url: '/inbox/t/1' } })]);
  expect(sendPushToUser).not.toHaveBeenCalled();
  expect(outcomeFor('e')).toBe('delivered_appilix');
});

test('type switched off → suppressed_type_disabled', async () => {
  controls.isNotificationTypeAllowed.mockResolvedValue(false);
  await dispatch([row('f')]);
  expect(outcomeFor('f')).toBe('suppressed_type_disabled');
});

test('push disabled → suppressed_push_disabled', async () => {
  repoMock.fetchUserNotificationPreferences.mockResolvedValue({ data: { push_enabled: false }, error: null });
  await dispatch([row('g')]);
  expect(outcomeFor('g')).toBe('suppressed_push_disabled');
});

test('quiet hours → suppressed_dnd', async () => {
  controls.isMemberInQuietHours.mockResolvedValue(true);
  await dispatch([row('h')]);
  expect(outcomeFor('h')).toBe('suppressed_dnd');
});

test('exception → dispatch_exception, row still handled', async () => {
  sendPushToUser.mockRejectedValue(new Error('boom'));
  await dispatch([row('i')]);
  expect(repoMock.markNotificationPushSent).toHaveBeenCalledWith(expect.anything(), 'i', expect.any(String));
  expect(outcomeFor('i')).toBe('dispatch_exception');
});

test('push_sent_at is written before the outcome, for every row', async () => {
  sendPushToUser.mockResolvedValue(0);
  sendAppilixPush.mockResolvedValue(false);
  await dispatch([row('j'), row('k')]);
  expect(order).toEqual(['sent_at:j', 'outcome:j', 'sent_at:k', 'outcome:k']);
});
