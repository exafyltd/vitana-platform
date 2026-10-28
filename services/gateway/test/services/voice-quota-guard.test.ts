// VTID-03107 — unit tests for the voice quota guard
// (voice-quota-guard.ts). Phase 7 (Voice/ORB tools) of
// docs/TEST_COVERAGE_PLAN.md.
//
// This module is a thin, side-effect-tracked wrapper around
// entitlement-service.ts (mocked at the module boundary here). Scope:
//   1. reserveVoiceQuotaAtSessionStart(): correct pass-through of args to
//      checkEntitlement(), and — the important gate — the
//      start_on_standard_tier boolean derivation for EVERY paywall_action
//      value ('allow' | 'soft_counter' | 'deferred' -> false;
//      'degrade' | 'paywall' | 'hard_block' -> true).
//   2. recordVoiceMinute(): the isDeferred short-circuit (D36 protection —
//      never advances the meter for a vulnerable user) vs. the normal path.
//   3. triggerDowngrade(): event shape, default vs. explicit reason, and
//      the two failure-mode branches — SSE-write failure (caught,
//      non-fatal) vs. recordPaywallEvent failure (NOT caught — propagates).
//   4. Dependency-failure behavior of reserveVoiceQuotaAtSessionStart when
//      checkEntitlement itself throws — documented as fail-mode, not fixed.

const mockCheckEntitlement = jest.fn();
const mockRecordUsage = jest.fn();
const mockRecordPaywallEvent = jest.fn();

jest.mock('../../src/services/entitlement-service', () => ({
  checkEntitlement: (...args: any[]) => mockCheckEntitlement(...args),
  recordUsage: (...args: any[]) => mockRecordUsage(...args),
  recordPaywallEvent: (...args: any[]) => mockRecordPaywallEvent(...args),
}));

import {
  reserveVoiceQuotaAtSessionStart,
  recordVoiceMinute,
  triggerDowngrade,
  _VTID,
} from '../../src/services/voice-quota-guard';
import type { CheckResult } from '../../src/services/entitlement-service';

function makeCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    allowed: true,
    paywall_action: 'allow',
    feature: 'voice_live_minutes',
    tier: 'free',
    quota: 60,
    used: 10,
    remaining: 50,
    reset_at: '2026-08-01T00:00:00.000Z',
    windows: [],
    binding_window: 'monthly',
    credit_cost_per_unit: 0,
    user_credit_balance: 0,
    allowed_burn_buckets: [],
    deferred_for_vulnerability: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockCheckEntitlement.mockReset();
  mockRecordUsage.mockReset();
  mockRecordPaywallEvent.mockReset();
});

describe('reserveVoiceQuotaAtSessionStart() — argument pass-through', () => {
  test('forwards userId/tenantId/feature and opts to checkEntitlement', async () => {
    mockCheckEntitlement.mockResolvedValue(makeCheckResult());

    await reserveVoiceQuotaAtSessionStart('user-1', 'tenant-1', {
      sessionId: 'sess-1',
      authToken: 'token-abc',
    });

    expect(mockCheckEntitlement).toHaveBeenCalledWith('user-1', 'tenant-1', 'voice_live_minutes', {
      amount: 1,
      sessionId: 'sess-1',
      authToken: 'token-abc',
    });
  });

  test('opts default to an empty object when omitted', async () => {
    mockCheckEntitlement.mockResolvedValue(makeCheckResult());

    await reserveVoiceQuotaAtSessionStart('user-1', 'tenant-1');

    expect(mockCheckEntitlement).toHaveBeenCalledWith('user-1', 'tenant-1', 'voice_live_minutes', {
      amount: 1,
      sessionId: undefined,
      authToken: undefined,
    });
  });

  test('the returned reservation surfaces quota/used/remaining/reset_at unchanged', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeCheckResult({ quota: 100, used: 99, remaining: 1, reset_at: '2026-09-01T00:00:00.000Z' }),
    );

    const res = await reserveVoiceQuotaAtSessionStart('user-1', 'tenant-1');

    expect(res.quota).toBe(100);
    expect(res.used).toBe(99);
    expect(res.remaining).toBe(1);
    expect(res.reset_at).toBe('2026-09-01T00:00:00.000Z');
    expect(res.feature).toBe('voice_live_minutes');
  });
});

describe('reserveVoiceQuotaAtSessionStart() — start_on_standard_tier gate (every paywall_action)', () => {
  const cases: Array<{ action: CheckResult['paywall_action']; expectStandard: boolean }> = [
    { action: 'allow', expectStandard: false },
    { action: 'soft_counter', expectStandard: false },
    { action: 'deferred', expectStandard: false },
    { action: 'degrade', expectStandard: true },
    { action: 'paywall', expectStandard: true },
    { action: 'hard_block', expectStandard: true },
  ];

  test.each(cases)(
    'paywall_action=$action -> start_on_standard_tier=$expectStandard',
    async ({ action, expectStandard }) => {
      mockCheckEntitlement.mockResolvedValue(makeCheckResult({ paywall_action: action }));

      const res = await reserveVoiceQuotaAtSessionStart('user-1', 'tenant-1');

      expect(res.paywall_action).toBe(action);
      expect(res.start_on_standard_tier).toBe(expectStandard);
    },
  );

  test('deferred_for_vulnerability is passed through from the entitlement result', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeCheckResult({ paywall_action: 'deferred', deferred_for_vulnerability: true }),
    );

    const res = await reserveVoiceQuotaAtSessionStart('user-1', 'tenant-1');

    expect(res.deferred_for_vulnerability).toBe(true);
  });

  test('deferred_for_vulnerability is false when the entitlement result says so', async () => {
    mockCheckEntitlement.mockResolvedValue(
      makeCheckResult({ paywall_action: 'allow', deferred_for_vulnerability: false }),
    );

    const res = await reserveVoiceQuotaAtSessionStart('user-1', 'tenant-1');

    expect(res.deferred_for_vulnerability).toBe(false);
  });
});

describe('reserveVoiceQuotaAtSessionStart() — dependency failure (fail-mode)', () => {
  test('propagates a checkEntitlement rejection rather than defaulting to allow or block', async () => {
    mockCheckEntitlement.mockRejectedValue(new Error('entitlement-service unreachable'));

    // NOTE (fail-mode finding): this function has no try/catch around
    // checkEntitlement(), so a transient entitlement-service outage bubbles
    // up as an unhandled rejection to the /orb/live/session/start route
    // rather than degrading to a safe default (e.g. start_on_standard_tier).
    // Documented here, not modified — this is a safety-net service and the
    // fix belongs to whoever owns the calling route's error handling.
    await expect(reserveVoiceQuotaAtSessionStart('user-1', 'tenant-1')).rejects.toThrow(
      'entitlement-service unreachable',
    );
  });
});

describe('recordVoiceMinute() — D36 deferred short-circuit', () => {
  test('isDeferred=true returns null WITHOUT calling recordUsage (meter must not advance)', async () => {
    const result = await recordVoiceMinute('user-1', 'tenant-1', true);

    expect(result).toBeNull();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  test('isDeferred=false calls recordUsage with feature=voice_live_minutes, amount=1', async () => {
    mockRecordUsage.mockResolvedValue(42);

    const result = await recordVoiceMinute('user-1', 'tenant-1', false);

    expect(mockRecordUsage).toHaveBeenCalledWith('user-1', 'tenant-1', 'voice_live_minutes', 1);
    expect(result).toBe(42);
  });

  test('isDeferred defaults to false when omitted', async () => {
    mockRecordUsage.mockResolvedValue(7);

    const result = await recordVoiceMinute('user-1', 'tenant-1');

    expect(mockRecordUsage).toHaveBeenCalledWith('user-1', 'tenant-1', 'voice_live_minutes', 1);
    expect(result).toBe(7);
  });

  test('propagates a null return from recordUsage (e.g. RPC failure) unchanged', async () => {
    mockRecordUsage.mockResolvedValue(null);

    const result = await recordVoiceMinute('user-1', 'tenant-1', false);

    expect(result).toBeNull();
  });
});

describe('triggerDowngrade() — event shape and defaults', () => {
  test('writes the SSE event with the documented wire format and default reason', async () => {
    const writeSse = jest.fn();
    mockRecordPaywallEvent.mockResolvedValue(undefined);

    await triggerDowngrade('user-1', 'tenant-1', writeSse);

    expect(writeSse).toHaveBeenCalledTimes(1);
    const [eventName, dataJson] = writeSse.mock.calls[0];
    expect(eventName).toBe('message');
    expect(JSON.parse(dataJson)).toEqual({
      type: 'orb.tier.downgraded',
      new_tier: 'standard',
      reason: 'daily_quota',
      feature: 'voice_live_minutes',
    });
  });

  test('honors an explicit reason', async () => {
    const writeSse = jest.fn();
    mockRecordPaywallEvent.mockResolvedValue(undefined);

    await triggerDowngrade('user-1', 'tenant-1', writeSse, 'session_quota');

    const dataJson = writeSse.mock.calls[0][1];
    expect(JSON.parse(dataJson).reason).toBe('session_quota');
  });

  test('records the paywall audit event with action=degraded and the reason/vtid context', async () => {
    const writeSse = jest.fn();
    mockRecordPaywallEvent.mockResolvedValue(undefined);

    await triggerDowngrade('user-1', 'tenant-1', writeSse, 'plan_exhausted');

    expect(mockRecordPaywallEvent).toHaveBeenCalledWith(
      'user-1',
      'tenant-1',
      'voice_live_minutes',
      'degraded',
      { reason: 'plan_exhausted', vtid: _VTID },
    );
  });

  test('an SSE write failure is caught and does NOT stop the paywall audit write', async () => {
    const writeSse = jest.fn(() => {
      throw new Error('client stream closed');
    });
    mockRecordPaywallEvent.mockResolvedValue(undefined);

    await expect(triggerDowngrade('user-1', 'tenant-1', writeSse)).resolves.toBeUndefined();

    expect(mockRecordPaywallEvent).toHaveBeenCalledTimes(1);
  });

  test('fail-mode: a recordPaywallEvent rejection is NOT caught and propagates', async () => {
    const writeSse = jest.fn();
    mockRecordPaywallEvent.mockRejectedValue(new Error('paywall_events insert failed'));

    // NOTE (fail-mode finding): unlike the writeSse call above, the
    // recordPaywallEvent() await is not wrapped in try/catch. A transient
    // DB failure here throws out of triggerDowngrade even though the SSE
    // downgrade notice was already successfully delivered to the client —
    // i.e. the client is told it's on Standard tier, but the audit trail
    // write can still fail the caller's request. Documented, not modified.
    await expect(triggerDowngrade('user-1', 'tenant-1', writeSse)).rejects.toThrow(
      'paywall_events insert failed',
    );
    expect(writeSse).toHaveBeenCalledTimes(1);
  });
});
