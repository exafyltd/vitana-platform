/**
 * Autopilot Automations Phase 1 — batch 4: engagement-loops gap closure
 * (AP-0503/0507 fixes, AP-0511 new) + health-wellness gap closure
 * (AP-0604/0609/0611/0615 fixes, AP-0605/0606 new).
 */

import {
  AUTOMATION_REGISTRY,
  getAutomation,
} from '../../src/services/automation-registry';
import { getHandler } from '../../src/services/automation-executor';
import { registerEngagementEventsHandlers } from '../../src/services/automation-handlers/engagement-events';
import { registerHealthWellnessHandlers } from '../../src/services/automation-handlers/health-wellness';
import { AutomationContext } from '../../src/types/automations';

registerEngagementEventsHandlers();
registerHealthWellnessHandlers();

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
        upsert: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        ilike: () => chain,
        like: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        contains: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  };
}

function makeCtx(
  supabase: any,
  metadata: Record<string, unknown> = {},
  queryTargetUsers: Array<{ user_id: string; active_role: string }> = []
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

describe('registry wiring — batch 4', () => {
  const expected: Record<string, string> = {
    'AP-0511': 'runFriendsChallengeSocialStreak',
    'AP-0605': 'runCommunityWellnessEventSuggestion',
    'AP-0606': 'runHealthDataExportReminder',
  };

  for (const [id, handlerName] of Object.entries(expected)) {
    it(`${id} has status IMPLEMENTED with handler ${handlerName}`, () => {
      const def = getAutomation(id);
      expect(def?.status).toBe('IMPLEMENTED');
      expect(def?.handler).toBe(handlerName);
      expect(getHandler(handlerName)).toBeInstanceOf(Function);
    });
  }

  it('AP-0508 and AP-0614 stay PLANNED (no live trigger dispatch site)', () => {
    expect(getAutomation('AP-0508')?.status).toBe('PLANNED');
    expect(getAutomation('AP-0614')?.status).toBe('PLANNED');
  });

  it('no engagement-loops/health-wellness automation marked IMPLEMENTED is missing a handler', () => {
    const domains = ['engagement-loops', 'health-wellness'];
    for (const def of AUTOMATION_REGISTRY.filter((d) => domains.includes(d.domain))) {
      if (def.status === 'IMPLEMENTED' || def.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
      }
    }
  });
});

describe('runFriendsChallengeSocialStreak (AP-0511)', () => {
  it('nudges both users of a connected pair who are both mid-streak', async () => {
    const supabase = makeFakeSupabase({
      user_diary_streak: [
        { data: { current_streak_days: 5, last_day: new Date().toISOString().slice(0, 10) }, error: null },
        { data: { current_streak_days: 4, last_day: new Date().toISOString().slice(0, 10) }, error: null },
      ],
      relationship_edges: [{ data: [{ target_id: 'f1' }], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runFriendsChallengeSocialStreak')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ usersAffected: 2, actionsTaken: 2 });
  });

  it('is a no-op when the user has no active streak', async () => {
    const supabase = makeFakeSupabase({
      user_diary_streak: [{ data: { current_streak_days: 1, last_day: new Date().toISOString().slice(0, 10) }, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runFriendsChallengeSocialStreak')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runDormantUserReEngagement (AP-0503)', () => {
  it('notifies dormant users who have pending daily_matches', async () => {
    const supabase = makeFakeSupabase({
      user_tenants: [{ data: [{ user_id: 'u1' }], error: null }],
      user_notifications: [{ count: 0, data: [], error: null }],
      daily_matches: [{ count: 3, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runDormantUserReEngagement')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runWellnessCheckIn (AP-0604)', () => {
  it('notifies a user with a significant Vitana Index decline', async () => {
    const supabase = makeFakeSupabase({
      user_tenants: [{ data: [{ user_id: 'u1' }], error: null }],
      vitana_index_scores: [
        { data: { score_total: 60 }, error: null },
        { data: { score_total: 80 }, error: null },
      ],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runWellnessCheckIn')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runCommunityWellnessEventSuggestion (AP-0605)', () => {
  it('suggests the nearest wellness-titled event to non-attending users', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [{ data: [{ id: 'e1', title: 'Sunrise Yoga', start_time: new Date().toISOString() }], error: null }],
      global_event_participants: [{ data: [], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runCommunityWellnessEventSuggestion')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when no upcoming event has a wellness-themed title', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [{ data: [{ id: 'e1', title: 'Board Game Night', start_time: new Date().toISOString() }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runCommunityWellnessEventSuggestion')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runHealthDataExportReminder (AP-0606)', () => {
  it('reminds patients who have lab reports on file', async () => {
    const supabase = makeFakeSupabase({
      lab_reports: [{ count: 2, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'patient' }]);
    const handler = getHandler('runHealthDataExportReminder')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips patients with no lab reports on file', async () => {
    const supabase = makeFakeSupabase({
      lab_reports: [{ count: 0, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'patient' }]);
    const handler = getHandler('runHealthDataExportReminder')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});
