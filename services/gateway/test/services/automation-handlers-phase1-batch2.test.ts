/**
 * Autopilot Automations Phase 1 — batch 2: events-live-rooms,
 * platform-operations, live-rooms-commerce, business-hub-marketplace.
 *
 * Registry/handler wiring checks for every automation touched in this
 * batch, plus a few deeper behavioral tests for representative handlers.
 */

import {
  AUTOMATION_REGISTRY,
  getAutomation,
} from '../../src/services/automation-registry';
import { getHandler } from '../../src/services/automation-executor';
import { registerEngagementEventsHandlers } from '../../src/services/automation-handlers/engagement-events';
import { registerPlatformOperationsHandlers } from '../../src/services/automation-handlers/platform-operations';
import { registerLiveRoomsCommerceHandlers } from '../../src/services/automation-handlers/live-rooms-commerce';
import { registerBusinessMarketplaceHandlers } from '../../src/services/automation-handlers/business-marketplace';
import { AutomationContext } from '../../src/types/automations';

registerEngagementEventsHandlers();
registerPlatformOperationsHandlers();
registerLiveRoomsCommerceHandlers();
registerBusinessMarketplaceHandlers();

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

describe('registry wiring — batch 2', () => {
  const expected: Record<string, string> = {
    'AP-0304': 'runPostEventFeedback',
    'AP-0306': 'runEventSeriesAutoSuggestion',
    'AP-0307': 'runLiveRoomFromTrendingChatTopic',
    'AP-0308': 'runNoShowFollowUp',
    'AP-0310': 'runGroupOutingBuilder',
    'AP-1003': 'runPostDeployHealthCheck',
    'AP-1004': 'runServiceErrorRateAlert',
    'AP-1005': 'runDatabaseMigrationVerification',
    'AP-1108': 'runCreatorAnalyticsGrowthTips',
    'AP-1109': 'runSeasonalTrendingRecommendations',
    'AP-1210': 'runLiveRoomRevenueOptimizationTips',
  };

  for (const [id, handlerName] of Object.entries(expected)) {
    it(`${id} has status IMPLEMENTED with handler ${handlerName}`, () => {
      const def = getAutomation(id);
      expect(def?.status).toBe('IMPLEMENTED');
      expect(def?.handler).toBe(handlerName);
      expect(getHandler(handlerName)).toBeInstanceOf(Function);
    });
  }

  it('AP-1206 stays PLANNED (handler exists but trigger event is never dispatched)', () => {
    const def = getAutomation('AP-1206');
    expect(def?.status).toBe('PLANNED');
  });

  it('no events-live-rooms/platform-operations/live-rooms-commerce/business-hub-marketplace automation marked IMPLEMENTED is missing a handler', () => {
    const domains = ['events-live-rooms', 'platform-operations', 'live-rooms-commerce', 'business-hub-marketplace'];
    for (const def of AUTOMATION_REGISTRY.filter((d) => domains.includes(d.domain))) {
      if (def.status === 'IMPLEMENTED' || def.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
      }
    }
  });
});

describe('runPostDeployHealthCheck (AP-1003)', () => {
  it('notifies ops when deploy failures exist in the lookback window', async () => {
    const supabase = makeFakeSupabase({
      oasis_events: [{ data: [{ topic: 'deploy.gateway.failed', service: 'gateway', status: 'error', message: 'build failed', created_at: new Date().toISOString() }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { service: 'gateway' }, [{ user_id: 'ops-1', active_role: 'admin' }]);
    const handler = getHandler('runPostDeployHealthCheck')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result.usersAffected).toBe(1);
  });

  it('is a no-op when there are no recent deploy failures', async () => {
    const supabase = makeFakeSupabase({ oasis_events: [{ data: [], error: null }] });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'ops-1', active_role: 'admin' }]);
    const handler = getHandler('runPostDeployHealthCheck')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runDatabaseMigrationVerification (AP-1005)', () => {
  it('is a no-op when payload has no expected_name/expected_tables', async () => {
    const supabase = makeFakeSupabase({});
    const { ctx, notify } = makeCtx(supabase, {});
    const handler = getHandler('runDatabaseMigrationVerification')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('reports failure when an expected table errors on query', async () => {
    const supabase = makeFakeSupabase({
      some_missing_table: [{ data: null, error: { message: 'relation does not exist' } }],
    });
    const { ctx, notify } = makeCtx(
      supabase,
      { expected_name: 'test_migration', expected_tables: ['some_missing_table'] },
      [{ user_id: 'ops-1', active_role: 'admin' }]
    );
    const handler = getHandler('runDatabaseMigrationVerification')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2].data.missing_tables).toContain('some_missing_table');
    expect(result.usersAffected).toBe(1);
  });
});

describe('runGroupOutingBuilder (AP-0310)', () => {
  it('suggests a group outing when 2+ connections are attending the same event', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: [{ data: [{ target_id: 'f1' }, { target_id: 'f2' }, { target_id: 'f3' }], error: null }],
      global_event_participants: [{ data: [{ user_id: 'f1' }, { user_id: 'f2' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', event_id: 'e1' });
    const handler = getHandler('runGroupOutingBuilder')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when fewer than 2 connections are attending', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: [{ data: [{ target_id: 'f1' }, { target_id: 'f2' }], error: null }],
      global_event_participants: [{ data: [{ user_id: 'f1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', event_id: 'e1' });
    const handler = getHandler('runGroupOutingBuilder')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});
