/**
 * automation-handlers/live-rooms-commerce.ts —
 * runLiveRoomRevenueOptimizationTips() (AP-1210) previously had zero test
 * coverage.
 *
 * fetchServicePaymentsForPayee()'s error was discarded entirely (not even
 * destructured) — on a real DB error, `revenueCents` stays 0, and a host
 * with real revenue this period gets the generic pricing tip with no
 * mention of what they actually earned, and nobody ever finds out the
 * revenue lookup failed. This pins that the error is now logged, while
 * the (unchanged) fallback — omit the revenue line rather than fabricate
 * a number — stays exactly as it was.
 */

const mockFetchRecentHostedRoomsWithPricing = jest.fn();
const mockCountAttendanceForRoomIds = jest.fn();
const mockFetchVitanaIdsForUsers = jest.fn();
const mockFetchServicePaymentsForPayee = jest.fn();

jest.mock('../../src/services/automation-handlers/live-rooms-commerce-repository', () => ({
  fetchRecentHostedRoomsWithPricing: (...args: unknown[]) => mockFetchRecentHostedRoomsWithPricing(...args),
  countAttendanceForRoomIds: (...args: unknown[]) => mockCountAttendanceForRoomIds(...args),
  fetchVitanaIdsForUsers: (...args: unknown[]) => mockFetchVitanaIdsForUsers(...args),
  fetchServicePaymentsForPayee: (...args: unknown[]) => mockFetchServicePaymentsForPayee(...args),
}));

import { registerLiveRoomsCommerceHandlers } from '../../src/services/automation-handlers/live-rooms-commerce';
import { getHandler } from '../../src/services/automation-executor';
import type { AutomationContext } from '../../src/types/automations';

registerLiveRoomsCommerceHandlers();

function buildCtx(): { ctx: AutomationContext; notify: jest.Mock } {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't1',
    targetRoles: 'all' as any,
    supabase: {},
    run: {
      id: 'run1', tenant_id: 't1', automation_id: 'AP-1210', trigger_type: 'heartbeat' as any,
      target_roles: 'all' as any, status: 'running' as any, users_affected: 0, actions_taken: 0,
      metadata: {}, started_at: new Date().toISOString(),
    },
    log: () => {},
    notify,
    emitEvent: async () => {},
    queryTargetUsers: async () => [],
  };
  return { ctx, notify };
}

describe('runLiveRoomRevenueOptimizationTips (AP-1210) — fetchServicePaymentsForPayee error visibility', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchRecentHostedRoomsWithPricing.mockResolvedValue({
      data: [
        { id: 'r1', host_user_id: 'host1', price_cents: 1000, capacity: 10 },
        { id: 'r2', host_user_id: 'host1', price_cents: 1000, capacity: 10 },
      ],
      error: null,
    });
    mockCountAttendanceForRoomIds.mockResolvedValue({ count: 5, error: null });
    mockFetchVitanaIdsForUsers.mockResolvedValue({ data: [{ user_id: 'host1', vitana_id: 'vtn-1' }], error: null });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs via console.error when the payments lookup errors, and omits the revenue line rather than fabricating €0', async () => {
    mockFetchServicePaymentsForPayee.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    const handler = getHandler('runLiveRoomRevenueOptimizationTips')!;
    const { ctx, notify } = buildCtx();
    await handler(ctx);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchServicePaymentsForPayee failed'));
    expect(notify).toHaveBeenCalledTimes(1);
    const body = notify.mock.calls[0][2].body as string;
    expect(body).not.toContain('€0.00');
    expect(body).not.toContain('You earned');
  });

  it('logs nothing and reports real revenue on a successful lookup', async () => {
    mockFetchServicePaymentsForPayee.mockResolvedValue({
      data: [{ amount_cents: 5000 }],
      error: null,
    });

    const handler = getHandler('runLiveRoomRevenueOptimizationTips')!;
    const { ctx, notify } = buildCtx();
    await handler(ctx);

    expect(errorSpy).not.toHaveBeenCalled();
    const body = notify.mock.calls[0][2].body as string;
    expect(body).toContain('You earned €50.00');
  });
});
