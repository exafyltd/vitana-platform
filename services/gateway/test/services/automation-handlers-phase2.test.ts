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

// AP-0910 batches embeddings via memory-facts-service's DEDICATED 768-dim
// generator (memory_facts.embedding is a fixed vector(768) column — a
// different dimension from memory_items' vector(1536), which the shared
// embedding-service.ts correctly serves instead); AP-0911 delegates to the
// synthesis service. Mock both so handler tests stay hermetic (no
// Vertex/OpenAI/DeepSeek calls).
jest.mock('../../src/services/memory-facts-service', () => ({
  generateFactEmbeddings: jest.fn(),
}));
jest.mock('../../src/services/user-model-synthesis', () => ({
  synthesizeUserModel: jest.fn(),
}));
import { generateFactEmbeddings } from '../../src/services/memory-facts-service';
import { synthesizeUserModel } from '../../src/services/user-model-synthesis';
const mockedBatchEmbed = generateFactEmbeddings as jest.MockedFunction<typeof generateFactEmbeddings>;
const mockedSynthesize = synthesizeUserModel as jest.MockedFunction<typeof synthesizeUserModel>;

// AP-0913 mirrors posts via orb-memory-bridge's writeMemoryItemWithIdentity,
// which opens its own real Supabase client internally (not injectable via
// ctx.supabase) — mock it so the handler test stays hermetic.
jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn(),
}));
import { writeMemoryItemWithIdentity } from '../../src/services/orb-memory-bridge';
const mockedWriteMemoryItem = writeMemoryItemWithIdentity as jest.MockedFunction<typeof writeMemoryItemWithIdentity>;

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
        filter: () => chain,
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
    'AP-0904': 'runSemanticMemoryContextForAutopilot',
    'AP-0905': 'runKnowledgeBaseContextForSuggestions',
    'AP-0906': 'runRoutinePatternExtraction',
    'AP-0907': 'runDailyLearningDigest',
    'AP-0908': 'runBehaviorPreferenceInference',
    'AP-0909': 'runRelationshipGraphProjection',
    'AP-0910': 'runMemoryEmbeddingBackfill',
    'AP-0911': 'runUserModelSynthesis',
    'AP-0912': 'runHealthCorrelationInsights',
    'AP-0913': 'runOwnPostMemoryCapture',
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

describe('AP-0903 retirement', () => {
  it('is DEPRECATED in the registry and its decay handler is gone (Loop 13 owns decay)', () => {
    const def = getAutomation('AP-0903');
    expect(def?.status).toBe('DEPRECATED');
    expect(def?.handler).toBeUndefined();
    expect(getHandler('runRelationshipGraphMaintenance')).toBeUndefined();
  });
});

describe('runRelationshipGraphProjection (AP-0909)', () => {
  it('projects a person-fact into a node + relation edge', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [
        { data: [{ user_id: 'u1', fact_key: 'spouse_name', fact_value: 'Maria', extracted_at: '2026-07-01T00:00:00Z' }], error: null },
      ],
      relationship_nodes: [
        { data: null, error: null }, // node lookup miss
        { data: { id: 'node-1' }, error: null }, // insert returns id
      ],
      relationship_edges: [
        { data: null, error: null }, // edge lookup miss
        { data: null, error: null }, // insert ok
      ],
      user_follows: [{ data: [], error: null }],
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphProjection')!;
    const result = await handler(ctx);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 2 }); // 1 node + 1 edge
    expect(ctx.emitEvent).toHaveBeenCalledWith('autopilot.memory.graph_projected', {
      nodes_created: 1,
      edges_created: 1,
      users_touched: 1,
    });
  });

  it('projects mutual follows into connected edges (both directions), one-way follows ignored', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [{ data: [], error: null }],
      user_follows: [
        {
          data: [
            { follower_id: 'a', following_id: 'b' },
            { follower_id: 'b', following_id: 'a' }, // mutual
            { follower_id: 'a', following_id: 'c' }, // one-way
          ],
          error: null,
        },
      ],
      relationship_edges: [
        { data: null, error: null }, // a→b lookup miss
        { data: null, error: null }, // a→b insert
        { data: null, error: null }, // b→a lookup miss
        { data: null, error: null }, // b→a insert
      ],
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphProjection')!;
    const result = await handler(ctx);
    expect(result.actionsTaken).toBe(2); // exactly the two directions of one mutual pair
  });

  it('is idempotent — existing nodes and edges are not recreated', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [
        { data: [{ user_id: 'u1', fact_key: 'friend_name', fact_value: 'Jovana', extracted_at: '2026-07-01T00:00:00Z' }], error: null },
      ],
      relationship_nodes: [{ data: { id: 'node-1' }, error: null }], // node exists
      relationship_edges: [
        { data: { id: 'edge-1' }, error: null }, // edge exists
        { data: null, error: null }, // last_interaction_at update
      ],
      user_follows: [{ data: [], error: null }],
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runRelationshipGraphProjection')!;
    const result = await handler(ctx);
    expect(result.actionsTaken).toBe(0);
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

describe('runDailyLearningDigest (AP-0907)', () => {
  it('notifies a user who gained facts and was not surfaced today', async () => {
    const supabase = makeFakeSupabase({
      // 1st: tenant-wide scan → u1; 2nd: detectNewFacts for u1
      memory_facts: [
        { data: [{ user_id: 'u1' }], error: null },
        { data: [{ fact_key: 'user_favorite_tea', fact_value: 'Earl Grey' }], error: null },
      ],
      // 1st: greeting-ledger row (none); 2nd: learning_surfaced (none); 3rd: upsert stamp
      user_assistant_state: [
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ],
      app_users: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runDailyLearningDigest')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][2];
    expect(payload.data.url).toBe('/memory');
    expect(payload.title.length).toBeGreaterThan(0);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('stays silent when the greeting already surfaced learning today', async () => {
    const today = new Date().toISOString();
    const supabase = makeFakeSupabase({
      memory_facts: [{ data: [{ user_id: 'u1' }], error: null }],
      user_assistant_state: [
        // greeting ledger says facts_learned was spoken today (3e won)
        { data: { value: { facts: { facts_learned: { value: 2, spoken_at: today } } } }, error: null },
      ],
      app_users: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runDailyLearningDigest')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('is a no-op when nobody learned anything', async () => {
    const supabase = makeFakeSupabase({ memory_facts: [{ data: [], error: null }] });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runDailyLearningDigest')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runBehaviorPreferenceInference (AP-0908)', () => {
  it('writes user_preference_* facts from high-confidence routines via write_fact', async () => {
    const supabase: any = makeFakeSupabase({
      user_routines: [
        {
          data: [
            { user_id: 'u1', routine_kind: 'time_of_day_preference', confidence: 0.8, metadata: { time_of_day: 'evening' } },
            { user_id: 'u1', routine_kind: 'category_affinity', confidence: 0.7, metadata: { tag: 'yoga' } },
          ],
          error: null,
        },
      ],
      memory_facts: [{ data: [], error: null }],
    });
    supabase.rpc = jest.fn(async () => ({ data: 'fact-uuid', error: null }));
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runBehaviorPreferenceInference')!;
    const result = await handler(ctx);
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.rpc).toHaveBeenCalledWith('write_fact', expect.objectContaining({
      p_fact_key: 'user_preference_active_time',
      p_fact_value: 'evening',
      p_provenance_source: 'behavior_inferred',
      p_provenance_confidence: 0.55,
    }));
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 2 });
  });

  it('skips identical existing facts (no supersession churn)', async () => {
    const supabase: any = makeFakeSupabase({
      user_routines: [
        {
          data: [
            { user_id: 'u1', routine_kind: 'time_of_day_preference', confidence: 0.8, metadata: { time_of_day: 'evening' } },
          ],
          error: null,
        },
      ],
      memory_facts: [
        { data: [{ user_id: 'u1', fact_key: 'user_preference_active_time', fact_value: 'evening' }], error: null },
      ],
    });
    supabase.rpc = jest.fn(async () => ({ data: 'fact-uuid', error: null }));
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runBehaviorPreferenceInference')!;
    const result = await handler(ctx);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runMemoryEmbeddingBackfill (AP-0910)', () => {
  it('embeds the unembedded backlog in one batch', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [
        { data: [{ id: 'f1', fact_key: 'user_favorite_tea', fact_value: 'Earl Grey' }], error: null },
        { data: null, error: null }, // update
      ],
    });
    mockedBatchEmbed.mockResolvedValue({ ok: true, embeddings: [[0.1, 0.2]], model: 'test-model' });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runMemoryEmbeddingBackfill')!;
    const result = await handler(ctx);
    expect(mockedBatchEmbed).toHaveBeenCalledWith(['user_favorite_tea: Earl Grey']);
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 1 });
  });

  it('is a no-op when the backlog is empty', async () => {
    const supabase = makeFakeSupabase({ memory_facts: [{ data: [], error: null }] });
    mockedBatchEmbed.mockClear();
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runMemoryEmbeddingBackfill')!;
    const result = await handler(ctx);
    expect(mockedBatchEmbed).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runUserModelSynthesis (AP-0911)', () => {
  it('synthesizes only users with at least 3 live facts', async () => {
    const supabase = makeFakeSupabase({
      memory_facts: [
        {
          data: [
            { user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u1' }, // 3 facts → eligible
            { user_id: 'u2' }, // 1 fact → skipped
          ],
          error: null,
        },
      ],
    });
    mockedSynthesize.mockReset();
    mockedSynthesize.mockResolvedValue({ ok: true, written: true });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runUserModelSynthesis')!;
    const result = await handler(ctx);
    expect(mockedSynthesize).toHaveBeenCalledTimes(1);
    expect(mockedSynthesize).toHaveBeenCalledWith(supabase, 't-1', 'u1');
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runHealthCorrelationInsights (AP-0912)', () => {
  it('writes a pillar-trend insight when a pillar moves >= 10 points', async () => {
    const supabase: any = makeFakeSupabase({
      vitana_index_scores: [
        {
          data: [
            { user_id: 'u1', date: '2026-06-24', score_sleep: 120, score_nutrition: 100, score_exercise: 100, score_hydration: 100, score_mental: 100 },
            { user_id: 'u1', date: '2026-06-28', score_sleep: 115, score_nutrition: 100, score_exercise: 100, score_hydration: 100, score_mental: 100 },
            { user_id: 'u1', date: '2026-07-02', score_sleep: 110, score_nutrition: 100, score_exercise: 100, score_hydration: 100, score_mental: 100 },
            { user_id: 'u1', date: '2026-07-06', score_sleep: 100, score_nutrition: 100, score_exercise: 100, score_hydration: 100, score_mental: 100 },
          ],
          error: null,
        },
      ],
      diary_entries: [{ data: [], error: null }],
    });
    supabase.rpc = jest.fn(async () => ({ data: 'fact-id', error: null }));
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runHealthCorrelationInsights')!;
    const result = await handler(ctx);
    expect(supabase.rpc).toHaveBeenCalledWith('write_fact', expect.objectContaining({
      p_fact_key: 'health_insight_sleep_trend',
      p_provenance_source: 'system_observed',
    }));
    expect(result.usersAffected).toBe(1);
  });

  it('writes a diary-lapse insight when a streak stops', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const supabase: any = makeFakeSupabase({
      vitana_index_scores: [{ data: [], error: null }],
      diary_entries: [
        {
          data: [
            { user_id: 'u1', created_at: eightDaysAgo },
            { user_id: 'u1', created_at: eightDaysAgo },
            { user_id: 'u1', created_at: eightDaysAgo },
          ],
          error: null,
        },
      ],
    });
    supabase.rpc = jest.fn(async () => ({ data: 'fact-id', error: null }));
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runHealthCorrelationInsights')!;
    const result = await handler(ctx);
    expect(supabase.rpc).toHaveBeenCalledWith('write_fact', expect.objectContaining({
      p_fact_key: 'health_insight_diary_lapse',
    }));
    expect(result.actionsTaken).toBe(1);
  });
});

describe('runOwnPostMemoryCapture (AP-0913)', () => {
  beforeEach(() => {
    mockedWriteMemoryItem.mockReset();
    mockedWriteMemoryItem.mockResolvedValue({ ok: true, id: 'mem-1', category_key: 'uncategorized' });
  });

  it('mirrors a new post into memory_items via writeMemoryItemWithIdentity', async () => {
    const supabase: any = makeFakeSupabase({
      profile_posts: [
        {
          data: [
            { id: 'post-1', user_id: 'u1', content: 'Finished my morning run!', created_at: '2026-07-09T06:00:00Z' },
          ],
          error: null,
        },
      ],
      memory_items: [{ data: [], error: null }], // nothing mirrored yet
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runOwnPostMemoryCapture')!;
    const result = await handler(ctx);

    expect(mockedWriteMemoryItem).toHaveBeenCalledWith(
      { user_id: 'u1', tenant_id: 't-1' },
      expect.objectContaining({
        source: 'system',
        content: 'Finished my morning run!',
        content_json: { kind: 'community_post', post_id: 'post-1' },
        occurred_at: '2026-07-09T06:00:00Z',
      }),
    );
    expect(result.actionsTaken).toBe(1);
    expect(result.usersAffected).toBe(1);
  });

  it('skips a post already mirrored (dedup by content_json->>post_id)', async () => {
    const supabase: any = makeFakeSupabase({
      profile_posts: [
        {
          data: [
            { id: 'post-1', user_id: 'u1', content: 'Already mirrored', created_at: '2026-07-09T06:00:00Z' },
          ],
          error: null,
        },
      ],
      memory_items: [{ data: [{ content_json: { post_id: 'post-1' } }], error: null }],
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runOwnPostMemoryCapture')!;
    const result = await handler(ctx);

    expect(mockedWriteMemoryItem).not.toHaveBeenCalled();
    expect(result.actionsTaken).toBe(0);
  });

  it('skips posts with no user_id or empty content', async () => {
    const supabase: any = makeFakeSupabase({
      profile_posts: [
        {
          data: [
            { id: 'post-1', user_id: null, content: 'orphaned', created_at: '2026-07-09T06:00:00Z' },
            { id: 'post-2', user_id: 'u1', content: '   ', created_at: '2026-07-09T06:00:00Z' },
          ],
          error: null,
        },
      ],
      memory_items: [{ data: [], error: null }],
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runOwnPostMemoryCapture')!;
    const result = await handler(ctx);

    expect(mockedWriteMemoryItem).not.toHaveBeenCalled();
    expect(result.actionsTaken).toBe(0);
  });

  it('returns zero without querying memory_items when profile_posts has nothing new', async () => {
    const supabase: any = makeFakeSupabase({
      profile_posts: [{ data: [], error: null }],
    });
    const { ctx } = makeCtx(supabase);
    const handler = getHandler('runOwnPostMemoryCapture')!;
    const result = await handler(ctx);

    expect(mockedWriteMemoryItem).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
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
