/**
 * VTID-04320 — reminders never fired because nothing called /reminders-tick
 * after the GCP scheduler was shut down. The tick/sweeper now live in
 * services/reminders-dispatch.ts, run in-process behind
 * REMINDERS_INPROCESS_DISPATCH_ENABLED, and skip reminders that are too far
 * overdue instead of pushing them days late.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/routes/scheduled-notifications-repository', () => ({
  closeStalePendingReminders: jest.fn(),
  rpcClaimDueReminders: jest.fn(),
  fallbackClaimDueReminders: jest.fn(),
  markReminderFired: jest.fn(),
  fetchStuckDispatchingReminders: jest.fn(),
  updateReminderRecoveryStatus: jest.fn(),
  countAppilixNativeDeviceTokens: jest.fn(),
  markReminderDeliveredViaFcm: jest.fn(),
}));
jest.mock('../src/services/notification-service', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(1),
  sendAppilixPush: jest.fn().mockResolvedValue(false),
  isSignedOutOnAllKnownDevices: jest.fn().mockResolvedValue(false),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));

import * as repo from '../src/routes/scheduled-notifications-repository';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import {
  resolveStaleAfterMinutes,
  isInProcessDispatchEnabled,
  skipStaleReminders,
  runRemindersTick,
  runRemindersSweeper,
  startRemindersDispatchLoop,
} from '../src/services/reminders-dispatch';

const r = repo as jest.Mocked<typeof repo>;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REMINDERS_STALE_AFTER_MINUTES;
  delete process.env.REMINDERS_INPROCESS_DISPATCH_ENABLED;
  r.closeStalePendingReminders.mockResolvedValue({ data: [], error: null } as any);
  r.markReminderFired.mockResolvedValue({ error: null } as any);
});

describe('flags', () => {
  it('stale threshold defaults to 60 minutes and ignores garbage', () => {
    expect(resolveStaleAfterMinutes(undefined)).toBe(60);
    expect(resolveStaleAfterMinutes('abc')).toBe(60);
    expect(resolveStaleAfterMinutes('0')).toBe(60);
    expect(resolveStaleAfterMinutes('15')).toBe(15);
  });

  it('in-process dispatch needs the exact string "true"', () => {
    expect(isInProcessDispatchEnabled(undefined)).toBe(false);
    expect(isInProcessDispatchEnabled('TRUE')).toBe(false);
    expect(isInProcessDispatchEnabled('1')).toBe(false);
    expect(isInProcessDispatchEnabled('true')).toBe(true);
  });

  it('startRemindersDispatchLoop does nothing while the flag is off', () => {
    expect(startRemindersDispatchLoop()).toBe(false);
  });
});

describe('stale guard', () => {
  it('closes pending reminders older than the threshold and records each one', async () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    r.closeStalePendingReminders.mockResolvedValue({
      data: [
        { id: 'a', user_id: 'u1', next_fire_at: '2026-09-11T16:00:00Z' },
        { id: 'b', user_id: 'u2', next_fire_at: '2026-09-22T10:00:00Z' },
      ],
      error: null,
    } as any);

    const n = await skipStaleReminders({}, now);

    expect(n).toBe(2);
    expect(r.closeStalePendingReminders).toHaveBeenCalledWith({}, { cutoff: '2026-09-23T09:00:00.000Z' });
    const topics = (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0].type);
    expect(topics).toEqual(['reminder.stale_skipped', 'reminder.stale_skipped']);
  });

  it('a failing guard never blocks the tick', async () => {
    r.closeStalePendingReminders.mockResolvedValue({ data: null, error: { message: 'boom' } } as any);
    r.rpcClaimDueReminders.mockResolvedValue({ data: [], error: null } as any);
    const res = await runRemindersTick({});
    expect(res).toMatchObject({ ok: true, fired: 0, stale_skipped: 0 });
  });

  it('the repository closes stale rows as failed/stale_skipped, only from pending', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/scheduled-notifications-repository.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function closeStalePendingReminders'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("status: 'failed', delivery_via: 'stale_skipped'");
    expect(body).toContain(".eq('status', 'pending')");
    expect(body).toContain(".lt('next_fire_at', args.cutoff)");
  });
});

describe('tick', () => {
  // scheduleReminderFcmPush waits 5s before pushing; keep that detached timer
  // from outliving the suite.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('guards stale rows BEFORE claiming, then fires every claimed row', async () => {
    const order: string[] = [];
    r.closeStalePendingReminders.mockImplementation((async () => {
      order.push('stale');
      return { data: [], error: null };
    }) as any);
    r.rpcClaimDueReminders.mockImplementation((async () => {
      order.push('claim');
      return {
        data: [
          { id: 'r1', user_id: 'u1', tenant_id: 't1', next_fire_at: new Date().toISOString(), action_text: 'Pills' },
          { id: 'r2', user_id: 'u2', tenant_id: 't1', next_fire_at: new Date().toISOString(), action_text: 'Walk' },
        ],
        error: null,
      };
    }) as any);

    const res = await runRemindersTick({});

    expect(order).toEqual(['stale', 'claim']);
    expect(res).toMatchObject({ ok: true, fired: 2, failed: 0, total: 2 });
    expect(r.markReminderFired).toHaveBeenCalledTimes(2);
  });

  it('counts a row whose fire update fails as failed, not fired', async () => {
    r.rpcClaimDueReminders.mockResolvedValue({
      data: [{ id: 'r1', user_id: 'u1', tenant_id: 't1', next_fire_at: new Date().toISOString() }],
      error: null,
    } as any);
    r.markReminderFired.mockResolvedValue({ error: { message: 'nope' } } as any);
    const res = await runRemindersTick({});
    expect(res).toMatchObject({ fired: 0, failed: 1 });
  });

  it('uses the non-atomic fallback only when the claim RPC errors', async () => {
    r.rpcClaimDueReminders.mockResolvedValue({ data: null, error: { message: 'no rpc' } } as any);
    r.fallbackClaimDueReminders.mockResolvedValue({ data: [], error: null } as any);
    const res = await runRemindersTick({});
    expect(r.fallbackClaimDueReminders).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('reports the fallback error instead of throwing', async () => {
    r.rpcClaimDueReminders.mockResolvedValue({ data: null, error: { message: 'no rpc' } } as any);
    r.fallbackClaimDueReminders.mockResolvedValue({ data: null, error: { message: 'db down' } } as any);
    const res = await runRemindersTick({});
    expect(res).toMatchObject({ ok: false, error: 'db down' });
  });
});

describe('sweeper', () => {
  it('returns stuck rows to pending and fails them at the 5th attempt', async () => {
    r.fetchStuckDispatchingReminders.mockResolvedValue({
      data: [
        { id: 'a', dispatch_attempts: 0 },
        { id: 'b', dispatch_attempts: 4 },
      ],
      error: null,
    } as any);
    r.updateReminderRecoveryStatus.mockResolvedValue({ error: null } as any);

    const res = await runRemindersSweeper({});

    expect(res).toMatchObject({ ok: true, recovered: 1, exhausted: 1, total: 2 });
    expect(r.updateReminderRecoveryStatus).toHaveBeenCalledWith({}, { reminderId: 'a', newStatus: 'pending', attempts: 1 });
    expect(r.updateReminderRecoveryStatus).toHaveBeenCalledWith({}, { reminderId: 'b', newStatus: 'failed', attempts: 5 });
  });
});

describe('wiring', () => {
  const root = path.resolve(__dirname, '..');
  const WF = path.resolve(root, '../../.github/workflows');

  it('the routes delegate to the shared service', () => {
    const route = fs.readFileSync(path.join(root, 'src/routes/scheduled-notifications.ts'), 'utf8');
    expect(route).toContain("router.post('/reminders-tick'");
    expect(route).toContain('await runRemindersTick(supa)');
    expect(route).toContain('await runRemindersSweeper(supa)');
    expect(route).not.toContain('async function scheduleReminderFcmPush');
  });

  it('gateway startup starts the loop', () => {
    const index = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
    expect(index).toContain("require('./services/reminders-dispatch')");
    expect(index).toContain('startRemindersDispatchLoop()');
  });

  it('staging pins the flag to exact "true" (strip-then-add); prod is untouched', () => {
    const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(staging).toContain('{name:"REMINDERS_INPROCESS_DISPATCH_ENABLED", value:"true"}');
    const strip = staging.slice(staging.indexOf('.containerDefinitions[0].environment |='));
    expect(strip.slice(0, strip.indexOf('| not) ]'))).toContain('"REMINDERS_INPROCESS_DISPATCH_ENABLED"');
    expect(prod).not.toContain('REMINDERS_INPROCESS_DISPATCH_ENABLED');
  });
});
