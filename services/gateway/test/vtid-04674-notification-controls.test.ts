/**
 * VTID-04674: the admin on/off switch per notification type, and the one
 * delivery decision every send path uses.
 */

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { emitOasisEvent } from '../src/services/oasis-event-service';
import {
  isNotificationTypeAllowed,
  isMemberCategoryAllowed,
  decidePushDelivery,
  isInQuietHours,
  clearNotificationControlCache,
  setNotificationControl,
  listNotificationControls,
  automationReadiness,
  NotificationControlError,
  CONTROL_CACHE_TTL_MS,
} from '../src/services/notification-controls/notification-controls-service';
import { NOTIFICATION_CATALOG } from '../src/services/notification-controls/notification-catalog';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-0000-0000-0000-000000000001';

type Result = { data?: any; error?: any; count?: number | null };

/** Fake client: rpc answers by function name; from() answers by table. */
function fakeSb(opts: {
  rpc?: Record<string, (args: any) => Result | Promise<Result>>;
  tables?: Record<string, Result | ((ops: any[]) => Result)>;
} = {}) {
  const calls: { rpc: Array<[string, any]>; from: Array<{ table: string; ops: any[] }> } = { rpc: [], from: [] };
  const sb: any = {
    rpc: jest.fn((name: string, args: any) => {
      calls.rpc.push([name, args]);
      const fn = opts.rpc?.[name];
      return Promise.resolve(fn ? fn(args) : { data: null, error: { message: `no rpc ${name}` } });
    }),
    from: jest.fn((table: string) => {
      const entry = { table, ops: [] as any[] };
      calls.from.push(entry);
      const chain: any = {};
      for (const m of ['select', 'eq', 'or', 'is', 'order', 'limit', 'insert', 'upsert', 'update', 'maybeSingle', 'single']) {
        chain[m] = (...args: any[]) => {
          entry.ops.push([m, ...args]);
          return chain;
        };
      }
      chain.then = (resolve: any, reject: any) => {
        const t = opts.tables?.[table];
        const value = typeof t === 'function' ? t(entry.ops) : t ?? { data: null, error: null };
        return Promise.resolve(value).then(resolve, reject);
      };
      return chain;
    }),
  };
  return { sb, calls };
}

beforeEach(() => {
  clearNotificationControlCache();
  jest.clearAllMocks();
});

describe('isNotificationTypeAllowed', () => {
  test('answers the database switch: off → false', async () => {
    const { sb, calls } = fakeSb({ rpc: { notification_type_allowed: () => ({ data: false, error: null }) } });
    await expect(isNotificationTypeAllowed(sb, TENANT, 'new_daily_matches')).resolves.toBe(false);
    expect(calls.rpc[0]).toEqual(['notification_type_allowed', { p_tenant: TENANT, p_type: 'new_daily_matches', p_source_key: '' }]);
  });

  test('passes the automation id as the source key', async () => {
    const { sb, calls } = fakeSb({ rpc: { notification_type_allowed: () => ({ data: true, error: null }) } });
    await isNotificationTypeAllowed(sb, TENANT, 'orb_suggestion', ' AP-0101 ');
    expect(calls.rpc[0][1].p_source_key).toBe('AP-0101');
  });

  test('reuses the answer within the cache window, re-reads after clear', async () => {
    const { sb } = fakeSb({ rpc: { notification_type_allowed: () => ({ data: true, error: null }) } });
    await isNotificationTypeAllowed(sb, TENANT, 'post_like');
    await isNotificationTypeAllowed(sb, TENANT, 'post_like');
    expect(sb.rpc).toHaveBeenCalledTimes(1);
    clearNotificationControlCache(TENANT, 'post_like');
    await isNotificationTypeAllowed(sb, TENANT, 'post_like');
    expect(sb.rpc).toHaveBeenCalledTimes(2);
    expect(CONTROL_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  test('fails open, loudly, when the switch cannot be read', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { sb } = fakeSb({ rpc: { notification_type_allowed: () => ({ data: null, error: { message: 'boom' } }) } });
    await expect(isNotificationTypeAllowed(sb, TENANT, 'post_like')).resolves.toBe(true);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('fail open'));
    err.mockRestore();
  });
});

describe('isMemberCategoryAllowed', () => {
  test('true/false from the database, null when unreadable', async () => {
    const off = fakeSb({ rpc: { notification_member_allows: () => ({ data: false, error: null }) } });
    await expect(isMemberCategoryAllowed(off.sb, USER, TENANT, 'post_like')).resolves.toBe(false);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = fakeSb();
    await expect(isMemberCategoryAllowed(bad.sb, USER, TENANT, 'post_like')).resolves.toBeNull();
    err.mockRestore();
  });
});

describe('isInQuietHours', () => {
  const prefs = { dnd_enabled: true, dnd_start_time: '22:00', dnd_end_time: '07:00' };
  test('overnight span', () => {
    expect(isInQuietHours(prefs, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(isInQuietHours(prefs, new Date(2026, 0, 1, 6, 59))).toBe(true);
    expect(isInQuietHours(prefs, new Date(2026, 0, 1, 12, 0))).toBe(false);
  });
  test('HH:MM:SS values from Postgres time columns', () => {
    expect(isInQuietHours({ dnd_enabled: true, dnd_start_time: '13:00:00', dnd_end_time: '14:00:00' }, new Date(2026, 0, 1, 13, 30))).toBe(true);
  });
  test('off or incomplete → never quiet', () => {
    expect(isInQuietHours({ ...prefs, dnd_enabled: false })).toBe(false);
    expect(isInQuietHours(null)).toBe(false);
  });
});

describe('decidePushDelivery', () => {
  const allOn = {
    notification_type_allowed: () => ({ data: true, error: null }),
    notification_member_allows: () => ({ data: true, error: null }),
    notification_record_block: () => ({ data: null, error: null }),
  };

  test('admin switch off → not sent, counted as admin_off', async () => {
    const { sb, calls } = fakeSb({ rpc: { ...allOn, notification_type_allowed: () => ({ data: false, error: null }) } });
    const d = await decidePushDelivery(sb, { userId: USER, tenantId: TENANT, type: 'reminder_due', prefs: null });
    expect(d).toEqual({ send: false, reason: 'admin_disabled' });
    await new Promise((r) => setImmediate(r));
    expect(calls.rpc.find(([n]) => n === 'notification_record_block')?.[1].p_reason).toBe('admin_off');
  });

  test('member category off → not sent, counted as member_off', async () => {
    const { sb, calls } = fakeSb({ rpc: { ...allOn, notification_member_allows: () => ({ data: false, error: null }) } });
    const d = await decidePushDelivery(sb, { userId: USER, tenantId: TENANT, type: 'reminder_due', prefs: null });
    expect(d).toEqual({ send: false, reason: 'member_category_off' });
    await new Promise((r) => setImmediate(r));
    expect(calls.rpc.find(([n]) => n === 'notification_record_block')?.[1].p_reason).toBe('member_off');
  });

  test('push switch off → not sent', async () => {
    const { sb } = fakeSb({ rpc: allOn });
    await expect(decidePushDelivery(sb, { userId: USER, tenantId: TENANT, type: 'reminder_due', prefs: { push_enabled: false } }))
      .resolves.toEqual({ send: false, reason: 'push_disabled' });
  });

  test('quiet hours hold a normal push but not a P0', async () => {
    const { sb } = fakeSb({ rpc: allOn });
    const quiet = { push_enabled: true, dnd_enabled: true, dnd_start_time: '00:00', dnd_end_time: '23:59' };
    await expect(decidePushDelivery(sb, { userId: USER, tenantId: TENANT, type: 'reminder_due', prefs: quiet }))
      .resolves.toEqual({ send: false, reason: 'quiet_hours' });
    await expect(decidePushDelivery(sb, { userId: USER, tenantId: TENANT, type: 'reminder_due', priority: 'p0', prefs: quiet }))
      .resolves.toEqual({ send: true });
  });

  test('loads the member prefs when not given', async () => {
    const { sb, calls } = fakeSb({
      rpc: allOn,
      tables: { user_notification_preferences: { data: { push_enabled: false }, error: null } },
    });
    await expect(decidePushDelivery(sb, { userId: USER, tenantId: TENANT, type: 'reminder_due' }))
      .resolves.toEqual({ send: false, reason: 'push_disabled' });
    expect(calls.from.map((c) => c.table)).toContain('user_notification_preferences');
  });

  test('everything on → sent', async () => {
    const { sb } = fakeSb({ rpc: allOn });
    await expect(decidePushDelivery(sb, { userId: USER, tenantId: TENANT, type: 'reminder_due', prefs: null }))
      .resolves.toEqual({ send: true });
  });
});

describe('setNotificationControl', () => {
  function writableSb(before: any = null) {
    return fakeSb({
      tables: {
        notification_type_controls: (ops) =>
          ops.some(([m]) => m === 'upsert') ? { data: null, error: null } : { data: before, error: null },
        notification_type_control_audit: { data: null, error: null },
      },
    });
  }

  test('switching on writes the row, the audit entry and the OASIS event', async () => {
    const { sb, calls } = writableSb({ enabled: false });
    const r = await setNotificationControl(sb, {
      tenantId: TENANT, type: 'post_like', enabled: true, reason: 'launch', actorUserId: USER, actorEmail: 'a@x.io',
    });
    expect(r).toEqual({ type: 'post_like', source_key: '', old_enabled: false, new_enabled: true });
    const upsert = calls.from.find((c) => c.ops.some(([m]) => m === 'upsert'))!;
    const row = upsert.ops.find(([m]) => m === 'upsert')[1];
    expect(row).toMatchObject({ tenant_id: TENANT, type: 'post_like', source_key: '', enabled: true, auto_registered: false, reason: 'launch' });
    const audit = calls.from.find((c) => c.table === 'notification_type_control_audit')!;
    expect(audit.ops[0][1]).toMatchObject({ old_enabled: false, new_enabled: true, actor_email: 'a@x.io' });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification.control.changed', vtid: 'VTID-04674' }));
  });

  test('refuses to switch on a type whose text is English only', async () => {
    const english = [...NOTIFICATION_CATALOG.values()].find((e) => e.text === 'not_localized')!;
    const { sb } = writableSb();
    await expect(setNotificationControl(sb, { tenantId: TENANT, type: english.type, enabled: true }))
      .rejects.toMatchObject({ code: 'not_localized' });
  });

  test('switching an English-only type OFF is always allowed', async () => {
    const english = [...NOTIFICATION_CATALOG.values()].find((e) => e.text === 'not_localized')!;
    const { sb } = writableSb({ enabled: true });
    await expect(setNotificationControl(sb, { tenantId: TENANT, type: english.type, enabled: false }))
      .resolves.toMatchObject({ new_enabled: false });
  });

  test('refuses to switch on an automation whose domain writes English only', async () => {
    const { sb } = writableSb();
    expect(automationReadiness('AP-0101')).toBe('not_localized');
    await expect(setNotificationControl(sb, { tenantId: TENANT, type: 'orb_suggestion', sourceKey: 'AP-0101', enabled: true }))
      .rejects.toBeInstanceOf(NotificationControlError);
  });

  test('rejects bad input', async () => {
    const { sb } = writableSb();
    await expect(setNotificationControl(sb, { tenantId: TENANT, type: 'drop table;', enabled: true }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(setNotificationControl(sb, { tenantId: TENANT, type: 'post_like', sourceKey: 'x', enabled: true }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(setNotificationControl(sb, { tenantId: TENANT, type: 'post_like', enabled: 'yes' as any }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('listNotificationControls', () => {
  test('catalog + types seen only in the database, with switch state and category', async () => {
    const { sb } = fakeSb({
      rpc: {
        notification_type_stats: () => ({
          data: [{ type: 'post_like', sent: '4', pushed: '3', read: '1', blocked_admin: '0', blocked_member: '2', last_sent_at: '2026-09-26T10:00:00Z' }],
          error: null,
        }),
      },
      tables: {
        notification_type_controls: {
          data: [
            { type: 'post_like', source_key: '', enabled: true, auto_registered: false },
            { type: 'brand_new_type', source_key: '', enabled: false, auto_registered: true },
            { type: 'orb_suggestion', source_key: 'AP-0101', enabled: false, auto_registered: true },
          ],
          error: null,
        },
        notification_categories: {
          data: [{ id: 'c1', tenant_id: null, slug: 'posts_reactions', display_name: 'Posts & reactions', mapped_types: ['post_like'] }],
          error: null,
        },
        user_tenants: { data: null, error: null, count: 12 },
      },
    });
    const r = await listNotificationControls(sb, TENANT, 7);
    const like = r.controls.find((c) => c.type === 'post_like')!;
    expect(like).toMatchObject({ enabled: true, in_catalog: true, audience: 'member', category: { slug: 'posts_reactions' } });
    expect(like.stats).toMatchObject({ sent: 4, pushed: 3, blocked_member: 2 });
    const unknown = r.controls.find((c) => c.type === 'brand_new_type')!;
    expect(unknown).toMatchObject({ in_catalog: false, enabled: false, auto_registered: true });
    const orb = r.controls.find((c) => c.type === 'orb_suggestion')!;
    expect(orb.enabled).toBe(false);
    expect(orb.automations).toEqual([expect.objectContaining({ source_key: 'AP-0101', enabled: false, can_enable: false })]);
    // A type nobody registered is off — never on by default.
    expect(r.controls.find((c) => c.type === 'morning_briefing_ready')!.enabled).toBe(false);
    expect(r.audience.member).toBe(12);
    expect(r.stats_error).toBeNull();
  });

  test('stats that cannot be read come back as an error, never as zeros', async () => {
    const { sb } = fakeSb({
      rpc: { notification_type_stats: () => ({ data: null, error: { message: 'timeout' } }) },
      tables: { notification_type_controls: { data: [], error: null }, notification_categories: { data: [], error: null } },
    });
    const r = await listNotificationControls(sb, TENANT);
    expect(r.stats_error).toBe('timeout');
    expect(r.controls.every((c) => c.stats === null)).toBe(true);
  });

  test('the switch table itself failing is an error', async () => {
    const { sb } = fakeSb({
      tables: { notification_type_controls: { data: null, error: { message: 'relation does not exist' } } },
    });
    await expect(listNotificationControls(sb, TENANT)).rejects.toThrow('relation does not exist');
  });
});

describe('catalog', () => {
  test('every entry has both languages and a known audience', () => {
    for (const e of NOTIFICATION_CATALOG.values()) {
      expect(e.label.en && e.label.de && e.description.en && e.description.de).toBeTruthy();
      expect(['member', 'admin', 'developer', 'staff']).toContain(e.audience);
    }
  });
});
