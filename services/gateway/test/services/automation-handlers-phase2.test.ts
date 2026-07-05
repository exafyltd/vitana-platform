/**
 * Autopilot Automations Phase 2 — the 5 previously-empty domains:
 * personalization-engines, memory-intelligence, event-meetup-initiative,
 * business-opportunity, health-action-initiative (25 automations total).
 *
 * Registry/handler wiring checks for every automation, plus a
 * representative behavioral test per domain.
 */

import {
  AUTOMATION_REGISTRY,
  getAutomation,
} from '../../src/services/automation-registry';
import { getHandler } from '../../src/services/automation-executor';
import { registerPersonalizationEnginesHandlers } from '../../src/services/automation-handlers/personalization-engines';
import { registerMemoryIntelligenceHandlers } from '../../src/services/automation-handlers/memory-intelligence';
import { registerEventMeetupInitiativeHandlers } from '../../src/services/automation-handlers/event-meetup-initiative';
import { registerBusinessOpportunityHandlers } from '../../src/services/automation-handlers/business-opportunity';
import { registerHealthActionInitiativeHandlers } from '../../src/services/automation-handlers/health-action-initiative';
import { AutomationContext } from '../../src/types/automations';

// AP-0906 fans out to the guide pattern-extractor — mock it so the handler
// test controls per-user results without a live supabase in the extractor.
jest.mock('../../src/services/guide/pattern-extractor', () => ({
  extractPatternsForUser: jest.fn(),
}));
import { extractPatternsForUser } from '../../src/services/guide/pattern-extractor';
const mockedExtract = extractPatternsForUser as jest.MockedFunction<typeof extractPatternsForUser>;

registerPersonalizationEnginesHandlers();
registerMemoryIntelligenceHandlers();
registerEventMeetupInitiativeHandlers();
registerBusinessOpportunityHandlers();
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
        upsert: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        is: () => chain,
        ilike: () => chain,
        like: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        contains: () => chain,
        overlaps: () => chain,
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

describe('registry wiring — Phase 2 (5 new domains)', () => {
  const expected: Record<string, string> = {
    'AP-0801': 'runSocialComfortAwareSuggestions',
    'AP-0802': 'runTasteAlignedEventRecommendations',
    'AP-0803': 'runOpportunitySurfacingAutomation',
    'AP-0804': 'runLifeStageAwareCommunication',
    'AP-0805': 'runOverloadDetectionThrottle',
    'AP-0901': 'runMemoryInformedMatching',
    'AP-0902': 'runFactExtractionAudit',
    'AP-0903': 'runRelationshipGraphMaintenance',
    'AP-0904': 'runSemanticMemoryContextForAutopilot',
    'AP-0905': 'runKnowledgeBaseContextForSuggestions',
    'AP-0906': 'runRoutinePatternExtraction',
    'AP-1401': 'runSmartEventCreation',
    'AP-1402': 'runCalendarAvailabilityCheck',
    'AP-1403': 'runAutoInvitationSender',
    'AP-1404': 'runEventDiscoveryRecommendation',
    'AP-1405': 'runSocialMeetupOrganizer',
    'AP-1501': 'runMarketplaceGapDetection',
    'AP-1502': 'runRevenueOpportunityAlert',
    'AP-1503': 'runServiceDemandMatching',
    'AP-1504': 'runBusinessSetupCoach',
    'AP-1505': 'runIncomeGrowthTips',
    'AP-1601': 'runLabTestKitOrdering',
    'AP-1602': 'runHealthScreeningScheduler',
    'AP-1603': 'runMotivationalHealthNudge',
    'AP-1604': 'runExerciseInitiation',
    'AP-1605': 'runSupplementReorderReminder',
  };

  for (const [id, handlerName] of Object.entries(expected)) {
    it(`${id} has status IMPLEMENTED with handler ${handlerName}`, () => {
      const def = getAutomation(id);
      expect(def?.status).toBe('IMPLEMENTED');
      expect(def?.handler).toBe(handlerName);
      expect(getHandler(handlerName)).toBeInstanceOf(Function);
    });
  }

  it('no automation in the 5 Phase-2 domains marked IMPLEMENTED is missing a handler', () => {
    const domains = [
      'personalization-engines', 'memory-intelligence', 'event-meetup-initiative',
      'business-opportunity', 'health-action-initiative',
    ];
    for (const def of AUTOMATION_REGISTRY.filter((d) => domains.includes(d.domain))) {
      if (def.status === 'IMPLEMENTED' || def.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
      }
    }
  });
});

describe('runSocialComfortAwareSuggestions (AP-0801)', () => {
  it('suggests a low-stakes action to a low-connection user', async () => {
    const supabase = makeFakeSupabase({
      user_notifications: [{ data: [], error: null }],
      relationship_edges: [{ count: 1, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runSocialComfortAwareSuggestions')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2].data.url).toBe('/community/groups');
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runOpportunitySurfacingAutomation (AP-0803)', () => {
  it('reminds a user of an opportunity expiring soon', async () => {
    const soon = new Date(Date.now() + 12 * 3_600_000).toISOString();
    const supabase = makeFakeSupabase({
      contextual_opportunities: [{ data: [{ id: 'o1', user_id: 'u1', title: 'Try This', why_now: 'because', expires_at: soon }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runOpportunitySurfacingAutomation')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when there are no soon-expiring opportunities', async () => {
    const supabase = makeFakeSupabase({ contextual_opportunities: [{ data: [], error: null }] });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runOpportunitySurfacingAutomation')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runMemoryInformedMatching (AP-0901)', () => {
  it('personalizes a match nudge using recent self-facts', async () => {
    const supabase = makeFakeSupabase({
      daily_matches: [{ data: { id: 'm1' }, error: null }],
      memory_facts: [{ data: [{ fact_value: 'loves hiking' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', match_id: 'm1' });
    const handler = getHandler('runMemoryInformedMatching')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when there are no self-facts on file', async () => {
    const supabase = makeFakeSupabase({
      daily_matches: [{ data: { id: 'm1' }, error: null }],
      memory_facts: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', match_id: 'm1' });
    const handler = getHandler('runMemoryInformedMatching')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runRelationshipGraphMaintenance (AP-0903)', () => {
  it('decays strength on stale edges', async () => {
    const supabase = makeFakeSupabase({
      relationship_edges: [{ data: [{ id: 'e1', strength: 50 }, { id: 'e2', strength: 5 }], error: null }],
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphMaintenance')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 2 });
  });
});

describe('runRoutinePatternExtraction (AP-0906)', () => {
  beforeEach(() => mockedExtract.mockReset());

  it('extracts routines once per distinct user with recent calendar activity', async () => {
    const supabase = makeFakeSupabase({
      calendar_events: [{ data: [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }], error: null }],
    });
    mockedExtract.mockImplementation(async (userId: string) => ({
      user_id: userId,
      routines_written: userId === 'u1' ? 2 : 0,
      routines: [],
      events_examined: 5,
    }));
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runRoutinePatternExtraction')!;
    const result = await handler(ctx);
    expect(mockedExtract).toHaveBeenCalledTimes(2);
    expect(mockedExtract).toHaveBeenCalledWith('u1');
    expect(mockedExtract).toHaveBeenCalledWith('u2');
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 2 });
    expect(ctx.emitEvent).toHaveBeenCalledWith('autopilot.memory.routines_extracted', {
      users_scanned: 2,
      users_with_routines: 1,
      routines_written: 2,
    });
  });

  it('is a no-op when nobody has recent calendar activity', async () => {
    const supabase = makeFakeSupabase({ calendar_events: [{ data: [], error: null }] });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runRoutinePatternExtraction')!;
    const result = await handler(ctx);
    expect(mockedExtract).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('keeps going when extraction fails for one user', async () => {
    const supabase = makeFakeSupabase({
      calendar_events: [{ data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null }],
    });
    mockedExtract
      .mockRejectedValueOnce(new Error('supabase down'))
      .mockResolvedValueOnce({ user_id: 'u2', routines_written: 1, routines: [], events_examined: 4 });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runRoutinePatternExtraction')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runCalendarAvailabilityCheck (AP-1402)', () => {
  it('warns about an overlapping personal calendar entry', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [{ data: { title: 'Community Yoga', start_time: '2026-08-01T10:00:00Z', end_time: '2026-08-01T11:00:00Z' }, error: null }],
      calendar_events: [{ data: [{ id: 'c1', title: 'Dentist' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', event_id: 'e1' });
    const handler = getHandler('runCalendarAvailabilityCheck')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when there is no conflict', async () => {
    const supabase = makeFakeSupabase({
      global_community_events: [{ data: { title: 'Community Yoga', start_time: '2026-08-01T10:00:00Z', end_time: '2026-08-01T11:00:00Z' }, error: null }],
      calendar_events: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', event_id: 'e1' });
    const handler = getHandler('runCalendarAvailabilityCheck')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runMarketplaceGapDetection (AP-1501)', () => {
  it('flags a high-demand category with zero recent supply', async () => {
    const supabase = makeFakeSupabase({
      global_community_groups: [{ data: [{ category: 'pilates', member_count: 40 }], error: null }],
      live_rooms: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'creator-1', active_role: 'professional' }]);
    const handler = getHandler('runMarketplaceGapDetection')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op when supply already covers demand', async () => {
    const supabase = makeFakeSupabase({
      global_community_groups: [{ data: [{ category: 'pilates', member_count: 40 }], error: null }],
      live_rooms: [{ data: [{ category: 'pilates' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'creator-1', active_role: 'professional' }]);
    const handler = getHandler('runMarketplaceGapDetection')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runLabTestKitOrdering (AP-1601)', () => {
  it('suggests a lab test to a user with no prior orders', async () => {
    const supabase = makeFakeSupabase({
      lab_tests: [{ data: { id: 'lt1', name: 'Full Panel' }, error: null }],
      lab_test_orders: [{ count: 0, data: [], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runLabTestKitOrdering')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips a user who already has a lab test order', async () => {
    const supabase = makeFakeSupabase({
      lab_tests: [{ data: { id: 'lt1', name: 'Full Panel' }, error: null }],
      lab_test_orders: [{ count: 1, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runLabTestKitOrdering')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});
