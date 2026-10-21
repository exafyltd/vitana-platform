/**
 * Swallowed-error regression tests — AP-1601 (runLabTestKitOrdering).
 *
 * Two fail-open checks gate this handler: countLabTestOrdersForUser
 * (lab_test_orders) must not re-suggest a test the user already ordered,
 * and fetchRecentAutomationSuggestion (user_notifications) must not
 * re-suggest within the cooldown. Both previously fell through silently
 * on error — this pins the fail-closed fix (log + skip that user).
 */

import { getHandler } from '../../src/services/automation-executor';
import { registerHealthActionInitiativeHandlers } from '../../src/services/automation-handlers/health-action-initiative';
import { AutomationContext } from '../../src/types/automations';

registerHealthActionInitiativeHandlers();

function makeFakeSupabase(resultsByTable: Record<string, Array<{ data?: any; count?: number; error?: any }>>) {
  const cursors: Record<string, number> = {};
  return {
    from(table: string) {
      const queue = resultsByTable[table] || [{ data: [], error: null }];
      const idx = Math.min(cursors[table] || 0, queue.length - 1);
      cursors[table] = (cursors[table] || 0) + 1;
      const result = queue[idx];
      const chain: any = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        contains: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
    rpc: jest.fn(async () => ({ data: null, error: null })),
  };
}

function makeCtx(
  supabase: any,
  metadata: Record<string, unknown> = {},
  queryTargetUsers: Array<{ user_id: string; active_role: string }> = [{ user_id: 'u1', active_role: 'community' }]
): { ctx: AutomationContext; notify: jest.Mock } {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1',
    targetRoles: 'all',
    supabase,
    run: {
      id: 'run-1', tenant_id: 't-1', automation_id: 'AP-TEST', trigger_type: 'heartbeat',
      target_roles: 'all', status: 'running', users_affected: 0, actions_taken: 0,
      metadata, started_at: new Date().toISOString(),
    },
    log: jest.fn(),
    notify,
    emitEvent: jest.fn(async () => {}),
    queryTargetUsers: jest.fn(async () => queryTargetUsers),
  };
  return { ctx, notify };
}

describe('runLabTestKitOrdering (AP-1601)', () => {
  const activeLabTest = { data: { id: 'test-1', name: 'Longevity Panel' }, error: null };

  it('suggests the lab test when the user has never ordered one and no recent suggestion exists', async () => {
    const supabase = makeFakeSupabase({
      lab_tests: [activeLabTest],
      lab_test_orders: [{ count: 0, data: [], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runLabTestKitOrdering')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips a user who already ordered the test', async () => {
    const supabase = makeFakeSupabase({
      lab_tests: [activeLabTest],
      lab_test_orders: [{ count: 1, data: [], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runLabTestKitOrdering')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('skips (does not re-suggest an already-ordered test) when countLabTestOrdersForUser errors, and logs it', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      lab_tests: [activeLabTest],
      lab_test_orders: [{ count: undefined, data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runLabTestKitOrdering')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('countLabTestOrdersForUser failed'));
    consoleErrorSpy.mockRestore();
  });

  it('skips (does not re-suggest within cooldown) when fetchRecentAutomationSuggestion errors, and logs it', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      lab_tests: [activeLabTest],
      lab_test_orders: [{ count: 0, data: [], error: null }],
      user_notifications: [{ data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runLabTestKitOrdering')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchRecentAutomationSuggestion failed'));
    consoleErrorSpy.mockRestore();
  });
});
