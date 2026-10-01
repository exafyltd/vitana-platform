/**
 * VTID-04674: every send path applies the admin switch.
 *   - notifyUser: switch off → nothing written, nothing pushed
 *   - notifyUser: the database guard dropped the row → no push either
 *   - reminders: the push waits on the full delivery decision
 *   - push-dispatch and the automation executor: source contracts
 */

import * as fs from 'fs';
import * as path from 'path';

const mockControls = {
  isNotificationTypeAllowed: jest.fn(),
  isMemberCategoryAllowed: jest.fn(),
  recordNotificationBlock: jest.fn(),
  decidePushDelivery: jest.fn(),
};

jest.mock('../src/services/notification-controls/notification-controls-service', () => {
  const actual = jest.requireActual('../src/services/notification-controls/notification-controls-service');
  return {
    ...actual,
    isNotificationTypeAllowed: (...a: any[]) => mockControls.isNotificationTypeAllowed(...a),
    isMemberCategoryAllowed: (...a: any[]) => mockControls.isMemberCategoryAllowed(...a),
    recordNotificationBlock: (...a: any[]) => mockControls.recordNotificationBlock(...a),
    decidePushDelivery: (...a: any[]) => mockControls.decidePushDelivery(...a),
  };
});

const mockRepo = {
  fetchUserNotificationPreferences: jest.fn(),
  insertUserNotification: jest.fn(),
  fetchLiveDeviceTokensForUser: jest.fn(),
  fetchAllDeviceTokensForUser: jest.fn(),
  fetchDeviceTokenRevocationStates: jest.fn(),
  fetchLiveDeviceTokensHeldByOthers: jest.fn(),
  fetchActiveNotificationCategories: jest.fn(),
  fetchUserCategoryPreference: jest.fn(),
  revokeDeviceToken: jest.fn(),
};
jest.mock('../src/services/notification-service-repository', () => mockRepo);

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn().mockResolvedValue(null),
}));

import { notifyUser } from '../src/services/notification-service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-0000-0000-0000-000000000001';
const sb: any = {};

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.fetchUserNotificationPreferences.mockResolvedValue({ data: { push_enabled: true, dnd_enabled: false }, error: null });
  mockRepo.insertUserNotification.mockResolvedValue({ data: { id: 'n1' }, error: null });
  mockRepo.fetchLiveDeviceTokensForUser.mockResolvedValue({ data: [], error: null });
  mockRepo.fetchAllDeviceTokensForUser.mockResolvedValue({ data: [], error: null });
  mockRepo.fetchDeviceTokenRevocationStates.mockResolvedValue({ data: [], error: null });
  mockRepo.fetchLiveDeviceTokensHeldByOthers.mockResolvedValue({ data: [], error: null });
  mockRepo.fetchActiveNotificationCategories.mockResolvedValue({ data: [], error: null });
  mockControls.isNotificationTypeAllowed.mockResolvedValue(true);
  mockControls.isMemberCategoryAllowed.mockResolvedValue(true);
});

describe('notifyUser', () => {
  test('admin switch off: nothing written, nothing pushed, counted', async () => {
    mockControls.isNotificationTypeAllowed.mockResolvedValue(false);
    const r = await notifyUser(USER, TENANT, 'post_like', { title: 't', body: 'b' }, sb);
    expect(r).toEqual({ pushed: 0, inapp: false, suppressed: 'admin_disabled' });
    expect(mockRepo.insertUserNotification).not.toHaveBeenCalled();
    expect(mockRepo.fetchLiveDeviceTokensForUser).not.toHaveBeenCalled();
    expect(mockControls.recordNotificationBlock).toHaveBeenCalledWith(sb, TENANT, 'post_like', '', 'admin_off');
  });

  test('an automation send is checked against its own switch', async () => {
    mockControls.isNotificationTypeAllowed.mockResolvedValue(false);
    await notifyUser(USER, TENANT, 'orb_suggestion', { title: 't', body: 'b', data: { automation_id: 'AP-0101' } }, sb);
    expect(mockControls.isNotificationTypeAllowed).toHaveBeenCalledWith(sb, TENANT, 'orb_suggestion', 'AP-0101');
  });

  test('member category off: nothing written, counted as member_off', async () => {
    mockControls.isMemberCategoryAllowed.mockResolvedValue(false);
    const r = await notifyUser(USER, TENANT, 'post_like', { title: 't', body: 'b' }, sb);
    expect(r.suppressed).toBe('category_post_like_disabled');
    expect(mockRepo.insertUserNotification).not.toHaveBeenCalled();
    expect(mockControls.recordNotificationBlock).toHaveBeenCalledWith(sb, TENANT, 'post_like', '', 'member_off');
  });

  test('the database guard dropped the row: no push', async () => {
    mockRepo.insertUserNotification.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: '0 rows' } });
    const r = await notifyUser(USER, TENANT, 'post_like', { title: 't', body: 'b' }, sb);
    expect(r).toEqual({ pushed: 0, inapp: false, suppressed: 'dropped_by_guard' });
    expect(mockRepo.fetchLiveDeviceTokensForUser).not.toHaveBeenCalled();
  });

  test('the legacy per-area columns no longer suppress (categories decide)', async () => {
    mockRepo.fetchUserNotificationPreferences.mockResolvedValue({
      data: { push_enabled: true, dnd_enabled: false, memory_notifications: false, community_notifications: false },
      error: null,
    });
    const r = await notifyUser(USER, TENANT, 'memory_garden_grew', { title: 't', body: 'b' }, sb);
    expect(r.suppressed).toBeUndefined();
    expect(mockRepo.insertUserNotification).toHaveBeenCalled();
  });

  test('switch on: row written as before', async () => {
    const r = await notifyUser(USER, TENANT, 'post_like', { title: 't', body: 'b' }, sb);
    expect(r.inapp).toBe(true);
    expect(mockRepo.insertUserNotification).toHaveBeenCalledWith(sb, expect.objectContaining({ type: 'post_like', tenant_id: TENANT }));
  });
});

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

describe('source contracts', () => {
  test('push-dispatch checks the admin switch before pushing a pending row', () => {
    const s = src('routes/scheduled-notifications.ts');
    const loop = s.slice(s.indexOf("router.post('/push-dispatch'"));
    const check = loop.indexOf('isNotificationTypeAllowed(supa, notif.tenant_id, notif.type, sourceKey)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(loop.indexOf('sendPushToUser('));
  });

  test('reminder push waits on the full delivery decision for reminder_due', () => {
    const s = src('services/reminders-dispatch.ts');
    const fn = s.slice(s.indexOf('export async function scheduleReminderFcmPush'));
    expect(s).toContain("REMINDER_NOTIFICATION_TYPE = 'reminder_due'");
    expect(fn.indexOf('decidePushDelivery(')).toBeGreaterThan(0);
    expect(fn.indexOf('decidePushDelivery(')).toBeLessThan(fn.indexOf('sendPushToUser('));
    expect(fn).toMatch(/if \(!decision\.send\)[\s\S]{0,120}return;/);
  });

  test('automation sends carry their automation id', () => {
    const s = src('services/automation-executor.ts');
    const notify = s.slice(s.indexOf('notify: (userId: string, type: string, payload)'));
    expect(notify.indexOf('automation_id: automationId')).toBeGreaterThan(0);
    expect(notify.indexOf('automation_id: automationId')).toBeLessThan(notify.indexOf('notifyUserAsync('));
  });

  test('no other code path pushes directly', () => {
    const root = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts')) {
          const rel = path.relative(root, p);
          if (rel === path.join('services', 'notification-service.ts')) continue;
          if (/await (sendPushToUser|sendAppilixPush|sendPushNotification)\(/.test(fs.readFileSync(p, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(root);
    // The two gated routes; a new one must add the switch check and be listed here.
    expect(offenders.sort()).toEqual([path.join('routes', 'scheduled-notifications.ts'), path.join('services', 'reminders-dispatch.ts')]);
  });
});

test('Admin › Notifications (compose/sent/stats) authenticates before the exafy_admin check', () => {
  expect(src('routes/admin-notifications.ts')).toContain('router.use(requireAuth, requireExafyAdmin);');
});

test('tenant-admin role lookup reads the service key the task definitions actually set', () => {
  expect(src('middleware/require-tenant-admin.ts')).toMatch(/SUPABASE_SERVICE_ROLE_KEY \|\| process\.env\.SUPABASE_SERVICE_ROLE \|\|/);
});
