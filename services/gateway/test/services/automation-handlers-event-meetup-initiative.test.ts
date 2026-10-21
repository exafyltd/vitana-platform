/**
 * Swallowed-error regression tests — AP-1401 (runSmartEventCreation) and
 * AP-1403 (runAutoInvitationSender).
 *
 * AP-1401's fetchRecentAutomationSuggestion (user_notifications) gates a
 * per-user cooldown; AP-1403's fetchEventParticipant (global_event_
 * participants) gates against re-inviting an already-invited connection.
 * Both previously fell through silently on error — this pins the
 * fail-closed fix (log + skip).
 */

import { getHandler } from '../../src/services/automation-executor';
import { registerEventMeetupInitiativeHandlers } from '../../src/services/automation-handlers/event-meetup-initiative';
import { AutomationContext } from '../../src/types/automations';

registerEventMeetupInitiativeHandlers();

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

describe('runSmartEventCreation (AP-1401)', () => {
  const connections = { data: [{ target_id: 'a' }, { target_id: 'b' }, { target_id: 'c' }], error: null };
  const topInterest = { data: { interest: 'hiking' }, error: null };

  it('suggests creating an event when the user qualifies and no recent suggestion exists', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: [connections],
      user_interests: [topInterest],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSmartEventCreation')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips (does not re-suggest within cooldown) when fetchRecentAutomationSuggestion errors, and logs it', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      relationship_edges: [connections],
      user_interests: [topInterest],
      user_notifications: [{ data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSmartEventCreation')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchRecentAutomationSuggestion failed'));
    consoleErrorSpy.mockRestore();
  });
});

describe('runAutoInvitationSender (AP-1403)', () => {
  const events = { data: [{ id: 'e1', title: 'Sunset Run', created_by: 'creator-1' }], error: null };
  const connections = { data: [{ target_id: 'conn-1' }], error: null };

  it('invites a connection not already registered for the event', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [events],
      relationship_edges: [connections],
      global_event_participants: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runAutoInvitationSender')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips a connection already registered for the event', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [events],
      relationship_edges: [connections],
      global_event_participants: [{ data: [{ id: 'p1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runAutoInvitationSender')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('skips (does not re-invite an already-invited connection) when fetchEventParticipant errors, and logs it', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      global_community_events: [events],
      relationship_edges: [connections],
      global_event_participants: [{ data: null, error: { message: 'db timeout' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runAutoInvitationSender')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchEventParticipant failed'));
    consoleErrorSpy.mockRestore();
  });
});
