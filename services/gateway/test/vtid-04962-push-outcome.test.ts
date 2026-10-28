// VTID-04962 — push delivery outcomes are truthful.
//
// Before: sendPushNotification() returned true for every FCM error except the
// two "token invalid" codes, so a credentials / permission / wrong-project
// failure counted as a delivered push. sendPushToUser() then reported > 0
// and the "FCM sent nothing → try Appilix" fallback never fired.
// After: an FCM error is 'error' — not delivered, token kept — the fallback
// fires, and the row records push_outcome.

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

import {
  sendPushNotification,
  sendPushToUser,
  notifyUser,
  classifyPushOutcome,
  newPushFanoutOutcome,
} from '../src/services/notification-service';

const supabase = {} as any;
const payload = { title: 'T', body: 'B' };
const fetchMock = jest.fn();

function fcmError(code: string) {
  return Object.assign(new Error(code), { code });
}

function appilixReplies(delivered: boolean) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(delivered ? { status: true } : { status: false, message: 'No devices' }),
  });
}

beforeAll(() => {
  (global as any).fetch = fetchMock;
  process.env.APPILIX_APP_KEY = 'app';
  process.env.APPILIX_API_KEY = 'api';
  delete process.env.APPILIX_IOS_APP_KEY;
  delete process.env.APPILIX_IOS_API_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  repo.fetchLiveDeviceTokensForUser.mockResolvedValue({ data: [{ fcm_token: 'tok-1', device_label: 'Chrome' }], error: null });
  repo.insertUserNotification.mockResolvedValue({ data: { id: 'notif-1' }, error: null });
  repo.fetchDeviceTokenRevocationStates.mockResolvedValue({ data: [], error: null });
  repo.fetchAllDeviceTokensForUser.mockResolvedValue({ data: [], error: null });
  appilixReplies(false);
});

const appilixCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('appilix.com'));

describe('sendPushNotification', () => {
  test('a credentials / permission error is an error, not a send', async () => {
    for (const code of ['app/invalid-credential', 'messaging/mismatched-credential', 'messaging/third-party-auth-error']) {
      fcmSend.mockRejectedValueOnce(fcmError(code));
      await expect(sendPushNotification('tok', payload)).resolves.toBe('error');
    }
  });

  test('an unregistered token is stale', async () => {
    fcmSend.mockRejectedValueOnce(fcmError('messaging/registration-token-not-registered'));
    await expect(sendPushNotification('tok', payload)).resolves.toBe('stale');
  });

  test('an accepted message is sent', async () => {
    fcmSend.mockResolvedValueOnce('msg-id');
    await expect(sendPushNotification('tok', payload)).resolves.toBe('sent');
  });
});

describe('sendPushToUser', () => {
  test('counts only accepted sends; an error neither counts nor revokes', async () => {
    fcmSend.mockRejectedValueOnce(fcmError('app/invalid-credential'));
    const tally = newPushFanoutOutcome();
    await expect(sendPushToUser('u1', 't1', payload, supabase, { outcome: tally })).resolves.toBe(0);
    expect(tally).toEqual({ sent: 0, stale: 0, errors: 1 });
    expect(repo.revokeDeviceToken).not.toHaveBeenCalled();
  });

  test('a stale token is revoked and not counted', async () => {
    fcmSend.mockRejectedValueOnce(fcmError('messaging/invalid-registration-token'));
    const tally = newPushFanoutOutcome();
    await expect(sendPushToUser('u1', 't1', payload, supabase, { outcome: tally })).resolves.toBe(0);
    expect(tally.stale).toBe(1);
    expect(repo.revokeDeviceToken).toHaveBeenCalledWith(supabase, 'tok-1', expect.objectContaining({ revoked_reason: 'fcm_invalid' }));
  });

  test('a success counts', async () => {
    fcmSend.mockResolvedValueOnce('msg-id');
    await expect(sendPushToUser('u1', 't1', payload, supabase)).resolves.toBe(1);
  });
});

describe('notifyUser (no deep link: FCM first, Appilix fallback)', () => {
  test('FCM credentials broken → Appilix fallback fires and the outcome is recorded', async () => {
    fcmSend.mockRejectedValue(fcmError('app/invalid-credential'));
    appilixReplies(true);
    const r = await notifyUser('u1', 't1', 'vtid_04962_test_type', payload, supabase);
    expect(r.pushed).toBe(0);
    expect(appilixCalls()).toHaveLength(1);
    expect(repo.setNotificationPushOutcome).toHaveBeenCalledWith(supabase, 'notif-1', 'delivered_appilix');
  });

  test('FCM broken and Appilix reaches nobody → fcm_error', async () => {
    fcmSend.mockRejectedValue(fcmError('app/invalid-credential'));
    appilixReplies(false);
    await notifyUser('u1', 't1', 'vtid_04962_test_type', payload, supabase);
    expect(repo.setNotificationPushOutcome).toHaveBeenCalledWith(supabase, 'notif-1', 'fcm_error');
  });

  test('FCM delivers → no Appilix push (no duplicate) and delivered_fcm', async () => {
    fcmSend.mockResolvedValue('msg-id');
    const r = await notifyUser('u1', 't1', 'vtid_04962_test_type', payload, supabase);
    expect(r.pushed).toBe(1);
    expect(appilixCalls()).toHaveLength(0);
    expect(repo.setNotificationPushOutcome).toHaveBeenCalledWith(supabase, 'notif-1', 'delivered_fcm');
  });

  test('no device anywhere → no_device', async () => {
    repo.fetchLiveDeviceTokensForUser.mockResolvedValue({ data: [], error: null });
    await notifyUser('u1', 't1', 'vtid_04962_test_type', payload, supabase);
    expect(repo.setNotificationPushOutcome).toHaveBeenCalledWith(supabase, 'notif-1', 'no_device');
  });

  test('a failed outcome write never fails the notification', async () => {
    fcmSend.mockResolvedValue('msg-id');
    repo.setNotificationPushOutcome.mockResolvedValueOnce({ error: { message: 'column "push_outcome" does not exist' } });
    await expect(notifyUser('u1', 't1', 'vtid_04962_test_type', payload, supabase)).resolves.toEqual(
      expect.objectContaining({ pushed: 1, inapp: true }),
    );
  });

  test('push_sent_at is still set at insert time (duplicate guard unchanged)', async () => {
    fcmSend.mockResolvedValue('msg-id');
    await notifyUser('u1', 't1', 'vtid_04962_test_type', payload, supabase);
    const row = repo.insertUserNotification.mock.calls[0][1];
    expect(row.push_sent_at).toEqual(expect.any(String));
    expect(row).not.toHaveProperty('push_outcome');
  });
});

describe('classifyPushOutcome', () => {
  const t = (sent: number, errors: number) => ({ sent, stale: 0, errors });
  test.each([
    [t(1, 0), true, 'delivered_both'],
    [t(1, 1), false, 'delivered_fcm'],
    [t(0, 1), true, 'delivered_appilix'],
    [t(0, 2), false, 'fcm_error'],
    [t(0, 0), false, 'no_device'],
  ])('%j appilix=%s → %s', (fcm, appilix, expected) => {
    expect(classifyPushOutcome(fcm, appilix as boolean)).toBe(expected);
  });
});
