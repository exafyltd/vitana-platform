/**
 * Swallowed-error regression test — AP-1004 (runServiceErrorRateAlert).
 *
 * fetchRecentServiceAlertRun gates a per-service cooldown so ops isn't
 * re-paged every cycle. An unchecked error there previously fell through
 * as "no recent alert", re-paging ops every run — this pins the fail-closed
 * fix (log + skip).
 */

import { getHandler } from '../../src/services/automation-executor';
import { registerPlatformOperationsHandlers } from '../../src/services/automation-handlers/platform-operations';
import { AutomationContext } from '../../src/types/automations';

registerPlatformOperationsHandlers();

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
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        contains: () => chain,
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
  queryTargetUsers: Array<{ user_id: string; active_role: string }> = [{ user_id: 'ops-1', active_role: 'admin' }]
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

describe('runServiceErrorRateAlert (AP-1004)', () => {
  it('alerts ops when a service breaches the error threshold and has no recent alert', async () => {
    const errorEvents = Array.from({ length: 6 }, (_, i) => ({ service: 'gateway', message: `err ${i}` }));
    const supabase = makeFakeSupabase({
      oasis_events: [{ data: errorEvents, error: null }],
      automation_runs: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runServiceErrorRateAlert')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips re-paging ops when a recent alert already exists for the service (cooldown)', async () => {
    const errorEvents = Array.from({ length: 6 }, (_, i) => ({ service: 'gateway', message: `err ${i}` }));
    const supabase = makeFakeSupabase({
      oasis_events: [{ data: errorEvents, error: null }],
      automation_runs: [{ data: [{ id: 'prior-run' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runServiceErrorRateAlert')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('skips (does not re-page ops) when fetchRecentServiceAlertRun errors, and logs it', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const errorEvents = Array.from({ length: 6 }, (_, i) => ({ service: 'gateway', message: `err ${i}` }));
    const supabase = makeFakeSupabase({
      oasis_events: [{ data: errorEvents, error: null }],
      automation_runs: [{ data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runServiceErrorRateAlert')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchRecentServiceAlertRun failed'));
    consoleErrorSpy.mockRestore();
  });
});
