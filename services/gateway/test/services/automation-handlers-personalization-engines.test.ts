/**
 * Swallowed-error regression tests — AP-0801/AP-0802 personalization-engines.
 *
 * Both handlers gate a per-user cooldown via fetchRecentAutomationSuggestion
 * (user_notifications). An unchecked error there previously fell through as
 * "no recent suggestion", re-suggesting inside the cooldown window — this
 * pins the fail-closed fix (log + skip that user).
 */

import { getHandler } from '../../src/services/automation-executor';
import { registerPersonalizationEnginesHandlers } from '../../src/services/automation-handlers/personalization-engines';
import { AutomationContext } from '../../src/types/automations';

registerPersonalizationEnginesHandlers();

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
        is: () => chain,
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

describe('runSocialComfortAwareSuggestions (AP-0801)', () => {
  it('suggests when no recent suggestion exists', async () => {
    const supabase = makeFakeSupabase({
      user_notifications: [{ data: [], error: null }],
      relationship_edges: [{ count: 1, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSocialComfortAwareSuggestions')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips within the cooldown when a recent suggestion exists', async () => {
    const supabase = makeFakeSupabase({
      user_notifications: [{ data: [{ id: 'n1' }], error: null }],
      relationship_edges: [{ count: 1, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSocialComfortAwareSuggestions')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('skips (does not re-suggest within cooldown) when fetchRecentAutomationSuggestion errors, and logs it', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      user_notifications: [{ data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSocialComfortAwareSuggestions')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchRecentAutomationSuggestion(AP-0801) failed'));
    consoleErrorSpy.mockRestore();
  });
});

describe('runTasteAlignedEventRecommendations (AP-0802)', () => {
  const events = [{ data: [{ id: 'e1', title: 'Yoga Retreat', event_type: 'wellness' }], error: null }];

  it('recommends a matching event when no recent suggestion exists', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: events,
      user_interests: [{ data: [{ interest: 'wellness' }], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runTasteAlignedEventRecommendations')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips (does not re-suggest within cooldown) when fetchRecentAutomationSuggestion errors, and logs it', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      global_community_events: events,
      user_interests: [{ data: [{ interest: 'wellness' }], error: null }],
      user_notifications: [{ data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runTasteAlignedEventRecommendations')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchRecentAutomationSuggestion(AP-0802) failed'));
    consoleErrorSpy.mockRestore();
  });
});
