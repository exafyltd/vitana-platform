// VTID-01142 — unit tests for the D48 Context-Aware Opportunity & Experience
// Surfacing Engine (d48-opportunity-surfacing-engine.ts).
//
// Scope:
//   1. Client selection — no authToken + not dev-sandbox => no DB, no catalog
//      candidates; authToken/dev-sandbox => catalog candidates generated.
//   2. User fatigue gate — checkUserFatigue() thresholds (none/low/medium/high)
//      via contextual_opportunities count; 'high' short-circuits generation
//      entirely (no OASIS success event, no dispatch, refresh=3600s).
//   3. Candidate generation & domain-consent gates — activity (health),
//      social (social_relationships), service/product catalog candidates
//      (including the two commerce governance gates: commerce_opted_out and
//      domain_consent.commerce_monetization).
//   4. Filtering — min_context_match threshold, timing<50 rejection, cooldown
//      (dismissed within N days), exclude_ids, requested_types — with
//      filter_reasons tallies.
//   5. Conversion — calculateOpportunityScore-driven suggested_action
//      (save vs view boundary at score>70) and generateWhyNow fragment
//      joining (single vs multi-fragment).
//   6. Sorting (type priority, then confidence) and max_opportunities_per_session
//      limiting.
//   7. Storage (contextual_opportunities insert) + AP-0110 dispatchEvent
//      (top opportunity only, never one per opportunity).
//   8. Error handling — thrown error inside the pipeline is caught, reported
//      as SURFACING_FAILED, and emits a `.failed` OASIS event.
//   9. dismissOpportunity / recordEngagement / getActiveOpportunities —
//      success/error paths, NO_DATABASE_CONNECTION, and tenant/user scoping
//      (every query explicitly filters by tenant_id + user_id — D48, unlike
//      D49, never relies on RLS alone).

const mockCreateClient = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

const mockDispatchEvent = jest.fn().mockResolvedValue({ dispatched: [], errors: [] });
jest.mock('../../src/services/automation-executor', () => ({
  dispatchEvent: (...args: any[]) => mockDispatchEvent(...args),
}));

import {
  surfaceOpportunities,
  dismissOpportunity,
  recordEngagement,
  getActiveOpportunities,
  DEFAULT_SURFACING_RULES,
} from '../../src/services/d48-opportunity-surfacing-engine';
import type {
  OpportunitySurfacingInput,
  PredictiveWindow,
} from '../../src/types/opportunity-surfacing';
import { getDefaultFusionContext, FusionContext } from '../../src/types/context-fusion';

// ---------------------------------------------------------------------------
// Chainable Supabase query-builder mock
// ---------------------------------------------------------------------------
//
// `responses[table]` is consulted per call to `.from(table)`, in call order
// (an array queues successive responses for repeated hits on the same
// table — e.g. contextual_opportunities is hit for the fatigue count, the
// cooldown/dismissed lookup, and finally the insert, in that fixed order).
// A function form receives the recorded chain (method + args) for that call
// so a test can assert on filters or simulate a rejection.

type ChainCall = [string, any[]];
interface ChainState {
  table: string;
  calls: ChainCall[];
}

function makeSupabase(responses: Record<string, any>) {
  const callIndex: Record<string, number> = {};
  const history: ChainState[] = [];

  function builder(table: string) {
    const state: ChainState = { table, calls: [] };
    const chain: any = {};
    const methods = ['select', 'insert', 'update', 'eq', 'gte', 'lt', 'in', 'order', 'limit', 'single'];
    for (const m of methods) {
      chain[m] = (...args: any[]) => {
        state.calls.push([m, args]);
        return chain;
      };
    }
    chain.then = (resolve: any, reject: any) => {
      history.push(state);
      const idx = callIndex[table] || 0;
      callIndex[table] = idx + 1;

      let entry = responses[table];
      let result: any;
      if (typeof entry === 'function') {
        result = entry(state, idx);
      } else if (Array.isArray(entry)) {
        result = entry[idx] ?? entry[entry.length - 1] ?? { data: null, error: null };
      } else {
        result = entry ?? { data: null, error: null };
      }
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  }

  return {
    from: jest.fn((t: string) => builder(t)),
    _history: history,
    _callsFor(table: string): ChainState[] {
      return history.filter((h) => h.table === table);
    },
  };
}

const TENANT = '00000000-0000-0000-0000-0000000000t1';
const USER = '00000000-0000-0000-0000-0000000000u1';

function baseInput(overrides: Partial<OpportunitySurfacingInput> = {}): OpportunitySurfacingInput {
  return {
    user_id: USER,
    tenant_id: TENANT,
    session_id: 'session-1',
    predictive_windows: {},
    anticipatory_guidance: {},
    social_alignment: {},
    ...overrides,
  };
}

function fusionOverride(overrides: Partial<FusionContext> = {}): Partial<FusionContext> {
  const base = getDefaultFusionContext();
  return { ...base, ...overrides };
}

const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  mockEmitOasisEvent.mockResolvedValue({ ok: true, event_id: 'evt-1' });
  mockDispatchEvent.mockResolvedValue({ dispatched: [], errors: [] });
  process.env = { ...OLD_ENV };
  delete process.env.ENVIRONMENT;
  delete process.env.VITANA_ENV;
});

afterAll(() => {
  process.env = OLD_ENV;
});

function eventTypes() {
  return mockEmitOasisEvent.mock.calls.map((c) => c[0].type);
}

// ---------------------------------------------------------------------------
// 1. No database (no authToken, not dev sandbox)
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — no database available', () => {
  it('still surfaces context-derived (activity/social) candidates without a supabase client', async () => {
    const recoveryWindow: PredictiveWindow = {
      id: 'win-1',
      type: 'recovery_window',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['health_wellbeing'],
      trigger_signals: [],
      explanation: 'You had a demanding week.',
      strength: 80,
      is_recurring: false,
    };

    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow] },
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.user_fatigue_level).toBe('none');
    expect(res.opportunities).toHaveLength(1);
    expect(res.opportunities![0].title).toBe('Recovery Routine');
    // No DB => no catalog candidates generated; total_considered reflects
    // only the context-derived candidate.
    expect(res.total_considered).toBe(1);
    // Never attempted to create a supabase client at all.
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('does not call dispatchEvent when zero opportunities are surfaced', async () => {
    const res = await surfaceOpportunities(baseInput());
    expect(res.opportunities).toHaveLength(0);
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Domain-consent gates
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — domain consent gates', () => {
  const recoveryWindow: PredictiveWindow = {
    id: 'win-1',
    type: 'recovery_window',
    horizon: 'today',
    starts_at: '2026-07-28T00:00:00Z',
    ends_at: '2026-07-28T12:00:00Z',
    confidence: 80,
    applicable_domains: ['health_wellbeing'],
    trigger_signals: [],
    explanation: 'Rest window',
    strength: 80,
    is_recurring: false,
  };

  it('suppresses activity candidates when health_wellbeing consent is false', async () => {
    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow] },
        fusion_context: fusionOverride({
          boundaries_consent: {
            ...getDefaultFusionContext().boundaries_consent,
            domain_consent: {
              ...getDefaultFusionContext().boundaries_consent.domain_consent,
              health_wellbeing: false,
            },
          },
        }),
      }),
    );
    expect(res.opportunities).toHaveLength(0);
    expect(res.total_considered).toBe(0);
  });

  it('suppresses social candidates when social_relationships consent is false', async () => {
    const res = await surfaceOpportunities(
      baseInput({
        social_alignment: {
          signals: [
            {
              id: 'sig-1',
              type: 'connection_opportunity',
              strength: 90,
              description: 'A friend is free this week',
              confidence: 80,
              recency: 90,
              opportunity_types: ['experience'],
            },
          ],
        },
        fusion_context: fusionOverride({
          boundaries_consent: {
            ...getDefaultFusionContext().boundaries_consent,
            domain_consent: {
              ...getDefaultFusionContext().boundaries_consent.domain_consent,
              social_relationships: false,
            },
          },
        }),
      }),
    );
    expect(res.opportunities).toHaveLength(0);
    expect(res.total_considered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. User fatigue
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — user fatigue gate', () => {
  beforeEach(() => {
    process.env.ENVIRONMENT = 'development';
  });

  it('high fatigue (>=15 today) short-circuits before any candidate generation', async () => {
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [{ count: 15 }],
      }),
    );

    const res = await surfaceOpportunities(baseInput());

    expect(res.ok).toBe(true);
    expect(res.user_fatigue_level).toBe('high');
    expect(res.opportunities).toEqual([]);
    expect(res.refresh_after_seconds).toBe(3600);
    // Only the fatigue-skip info event — no success event, no dispatch.
    expect(eventTypes()).toEqual(['opportunity.surfaced']);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'info', message: expect.stringMatching(/fatigue/i) }),
    );
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });

  it.each([
    [4, 'none'],
    [5, 'low'],
    [9, 'low'],
    [10, 'medium'],
    [14, 'medium'],
    [15, 'high'],
  ])('count=%i maps to fatigue level %s', async (count, expected) => {
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [{ count }, { data: [] }, { error: null }],
        services_catalog: { data: [], error: null },
        products_catalog: { data: [], error: null },
      }),
    );

    const res = await surfaceOpportunities(baseInput());
    expect(res.user_fatigue_level).toBe(expected);
  });

  it('medium fatigue does not block generation (only high does)', async () => {
    const recoveryWindow: PredictiveWindow = {
      id: 'win-1',
      type: 'health_opportunity',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['health_wellbeing'],
      trigger_signals: [],
      explanation: 'Check in window',
      strength: 80,
      is_recurring: false,
    };
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [{ count: 10 }, { data: [] }, { error: null }],
        services_catalog: { data: [], error: null },
        products_catalog: { data: [], error: null },
      }),
    );

    const res = await surfaceOpportunities(
      baseInput({ predictive_windows: { active_windows: [recoveryWindow] } }),
    );
    expect(res.user_fatigue_level).toBe('medium');
    expect(res.opportunities!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Catalog candidate generation (service/product) + commerce gates
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — catalog candidates (service/product)', () => {
  const richFusion = () =>
    fusionOverride({
      goals_trajectory: {
        active_goals: [
          { id: 'g1', domain: 'health_wellbeing', description: 'improve sleep quality', priority: 'high' },
        ],
        trajectory_alignment: 'on_track',
        time_horizon_focus: 'balanced',
        confidence: 80,
      },
      taste_lifestyle: {
        active_preferences: ['yoga'],
        style_signals: {},
        confidence: 80,
      },
      health_capacity: {
        energy_level: 80,
        availability: 'high',
        active_health_concerns: ['sleep'],
        safety_flags: [],
        confidence: 80,
      },
      boundaries_consent: {
        ...getDefaultFusionContext().boundaries_consent,
        domain_consent: {
          ...getDefaultFusionContext().boundaries_consent.domain_consent,
          health_wellbeing: true,
          commerce_monetization: true,
        },
        commerce_opted_out: false,
      },
    });

  it('maps service_type to opportunity_type (coach->service, fitness->activity) and scores context/preference/social matches', async () => {
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [{ count: 0 }, { data: [] }, { error: null }],
        services_catalog: {
          data: [
            { id: 'svc-1', name: 'Sleep Coach', service_type: 'coach', topic_keys: ['sleep', 'yoga'], provider_name: 'Ada' },
            { id: 'svc-2', name: 'Morning Fitness Class', service_type: 'fitness', topic_keys: ['sleep', 'yoga'], provider_name: null },
          ],
          error: null,
        },
        products_catalog: { data: [], error: null },
      }),
    );

    const res = await surfaceOpportunities(
      baseInput({ fusion_context: richFusion() }),
    );

    expect(res.ok).toBe(true);
    const svc = res.opportunities!.find((o) => o.external_id === 'svc-1');
    const fitness = res.opportunities!.find((o) => o.external_id === 'svc-2');
    expect(svc).toBeDefined();
    expect(svc!.opportunity_type).toBe('service');
    expect(svc!.title).toBe('Sleep Coach');
    expect(svc!.description).toBe('coach by Ada');
    expect(svc!.relevance_factors).toEqual(expect.arrayContaining(['goal_match', 'preference_match']));
    expect(svc!.why_now).toBe('Aligns well with your current context.');
    // context_match=100 (goal+pref+concern+availability all match), timing=50,
    // preference=65, social=40 -> raw 69.5 -> round 70; type priority 'service'=50 ->
    // multiplier 0.75 -> round(70*0.75)=53 (or 52 depending on JS round(69.5) vs
    // round(52.5) rounding rules) — assert exact regression value.
    expect(svc!.confidence).toBe(Math.round(69.5 * 0.75));

    expect(fitness).toBeDefined();
    expect(fitness!.opportunity_type).toBe('activity');
  });

  it('filters out a service candidate when its mapped domain lacks consent', async () => {
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [{ count: 0 }, { data: [] }, { error: null }],
        services_catalog: {
          data: [{ id: 'svc-1', name: 'Sleep Coach', service_type: 'coach', topic_keys: ['sleep'], provider_name: 'Ada' }],
          error: null,
        },
        products_catalog: { data: [], error: null },
      }),
    );

    const fusion = richFusion();
    (fusion.boundaries_consent as any).domain_consent.health_wellbeing = false;

    const res = await surfaceOpportunities(baseInput({ fusion_context: fusion }));
    expect(res.opportunities!.find((o) => o.external_id === 'svc-1')).toBeUndefined();
  });

  it('never queries products_catalog when commerce_opted_out is true (default)', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({
      contextual_opportunities: [{ count: 0 }, { data: [] }, { error: null }],
      services_catalog: { data: [], error: null },
    });
    mockCreateClient.mockReturnValue(supa);

    await surfaceOpportunities(baseInput());
    expect(supa._callsFor('products_catalog')).toHaveLength(0);
  });

  it('never queries products_catalog when commerce_monetization consent is false, even if commerce_opted_out is false', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({
      contextual_opportunities: [{ count: 0 }, { data: [] }, { error: null }],
      services_catalog: { data: [], error: null },
    });
    mockCreateClient.mockReturnValue(supa);

    const fusion = fusionOverride({
      boundaries_consent: {
        ...getDefaultFusionContext().boundaries_consent,
        commerce_opted_out: false,
        domain_consent: { ...getDefaultFusionContext().boundaries_consent.domain_consent, commerce_monetization: false },
      },
    });

    await surfaceOpportunities(baseInput({ fusion_context: fusion }));
    expect(supa._callsFor('products_catalog')).toHaveLength(0);
  });

  it('surfaces a product candidate (offer type, budget_match factor) once both commerce gates are open', async () => {
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [{ count: 0 }, { data: [] }, { error: null }],
        services_catalog: { data: [], error: null },
        products_catalog: {
          data: [{ id: 'prod-1', name: 'Sleep Kit', product_type: 'supplement', topic_keys: ['sleep', 'yoga'] }],
          error: null,
        },
      }),
    );

    const res = await surfaceOpportunities(
      baseInput({
        budget_sensitivity: 'low',
        fusion_context: richFusion(),
      }),
    );

    const prod = res.opportunities!.find((o) => o.external_id === 'prod-1');
    expect(prod).toBeDefined();
    expect(prod!.opportunity_type).toBe('offer');
    expect(prod!.priority_domain).toBe('commerce_monetization');
    expect(prod!.relevance_factors).toEqual(expect.arrayContaining(['budget_match']));
  });
});

// ---------------------------------------------------------------------------
// 5. Filtering
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — filtering', () => {
  const recoveryWindow: PredictiveWindow = {
    id: 'win-1',
    type: 'recovery_window',
    horizon: 'today',
    starts_at: '2026-07-28T00:00:00Z',
    ends_at: '2026-07-28T12:00:00Z',
    confidence: 80,
    applicable_domains: ['health_wellbeing'],
    trigger_signals: [],
    explanation: 'Rest window',
    strength: 80,
    is_recurring: false,
  };

  it('rejects a candidate below the configured min_context_match (context_match_low)', async () => {
    // Recovery candidate has context_match=85; raise the bar above it.
    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow] },
        surfacing_rules: { min_context_match: 90 },
      }),
    );
    expect(res.opportunities).toHaveLength(0);
    expect(res.filter_reasons).toMatchObject({ context_match_low: 1 });
  });

  it('rejects a candidate with timing_match below 50 (timing_not_relevant)', async () => {
    const socialWindow: PredictiveWindow = {
      id: 'win-2',
      type: 'social_opportunity',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['social_relationships'],
      trigger_signals: [],
      explanation: 'low-strength window',
      strength: 30, // becomes candidate.timing_match, <50
      is_recurring: false,
    };
    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [socialWindow] },
        surfacing_rules: { min_context_match: 50 },
      }),
    );
    expect(res.opportunities).toHaveLength(0);
    expect(res.filter_reasons).toMatchObject({ timing_not_relevant: 1 });
  });

  it('respects the dismissal cooldown (in_cooldown) using contextual_opportunities.status=dismissed', async () => {
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [
          { count: 0 }, // fatigue
          { data: [{ external_id: 'recovery-win-1' }] }, // dismissed cooldown lookup
        ],
        services_catalog: { data: [], error: null },
        products_catalog: { data: [], error: null },
      }),
    );

    const res = await surfaceOpportunities(
      baseInput({ predictive_windows: { active_windows: [recoveryWindow] } }),
    );
    expect(res.opportunities).toHaveLength(0);
    expect(res.filter_reasons).toMatchObject({ in_cooldown: 1 });
  });

  it('respects exclude_ids (excluded)', async () => {
    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow] },
        exclude_ids: ['recovery-win-1'],
      }),
    );
    expect(res.opportunities).toHaveLength(0);
    expect(res.filter_reasons).toMatchObject({ excluded: 1 });
  });

  it('respects requested_types (type_not_requested)', async () => {
    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow] },
        requested_types: ['offer'], // recovery candidate is 'activity'
      }),
    );
    expect(res.opportunities).toHaveLength(0);
    expect(res.filter_reasons).toMatchObject({ type_not_requested: 1 });
  });
});

// ---------------------------------------------------------------------------
// 6. Conversion — score -> suggested_action, why_now fragment joining
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — conversion (score, suggested_action, why_now)', () => {
  it('yields "save" for confidence in (70,85] and "view" at or below 70, with correct why_now joining', async () => {
    const recoveryWindow: PredictiveWindow = {
      id: 'win-1',
      type: 'recovery_window',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['health_wellbeing'],
      trigger_signals: [],
      explanation: 'Rest window explanation',
      strength: 80,
      is_recurring: false,
    };
    const guidance = {
      id: 'guide-1',
      type: 'reinforcement_prompt' as const,
      domain: 'health_wellbeing' as const,
      priority_level: 2 as const,
      message: 'Keep going',
      why_now: 'You kept your streak going three days in a row.',
      suggested_timing: 'now' as const,
      confidence: 80,
      evidence: [],
      dismissible: true,
      cooldown_days: 7,
    };

    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow] },
        anticipatory_guidance: { active_guidance: [guidance] },
        surfacing_rules: { min_context_match: 70, max_opportunities_per_session: 10 },
      }),
    );

    const recovery = res.opportunities!.find((o) => o.title === 'Recovery Routine');
    const progress = res.opportunities!.find((o) => o.title === 'Continue Your Progress');

    expect(recovery).toBeDefined();
    expect(recovery!.confidence).toBe(74); // save branch (>70)
    expect(recovery!.suggested_action).toBe('save');
    // Two why_now_fragments -> joined "first second".
    expect(recovery!.why_now).toBe('Rest window explanation Now is a good time for recovery.');

    expect(progress).toBeDefined();
    expect(progress!.confidence).toBe(69); // view branch (<=70)
    expect(progress!.suggested_action).toBe('view');
    // Single fragment -> returned verbatim.
    expect(progress!.why_now).toBe('You kept your streak going three days in a row.');
  });

  it('falls back to the generic why_now when a candidate has no fragments', async () => {
    // A service candidate with no matching windows/preferences produces
    // context_match=50 (base only), so no "Aligns well..." fragment and no
    // window-derived fragment either -> generateWhyNow([]) generic default.
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({
        contextual_opportunities: [{ count: 0 }, { data: [] }, { error: null }],
        services_catalog: {
          data: [{ id: 'svc-1', name: 'Generic Service', service_type: 'coach', topic_keys: [], provider_name: null }],
          error: null,
        },
        products_catalog: { data: [], error: null },
      }),
    );

    const res = await surfaceOpportunities(
      baseInput({ surfacing_rules: { min_context_match: 0 } }),
    );
    const svc = res.opportunities!.find((o) => o.external_id === 'svc-1');
    expect(svc).toBeDefined();
    expect(svc!.why_now).toBe('Based on your current context and preferences.');
  });
});

// ---------------------------------------------------------------------------
// 7. Sorting & limits
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — sorting & session limit', () => {
  it('sorts by opportunity_type priority (activity > place > experience) before confidence, and applies max_opportunities_per_session', async () => {
    const recoveryWindow: PredictiveWindow = {
      id: 'win-1',
      type: 'recovery_window',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['health_wellbeing'],
      trigger_signals: [],
      explanation: 'Rest window',
      strength: 80,
      is_recurring: false,
    };
    const socialWindow: PredictiveWindow = {
      id: 'win-2',
      type: 'social_opportunity',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['social_relationships'],
      trigger_signals: [],
      explanation: 'Social window',
      strength: 90, // timing_match=90, place type
      is_recurring: false,
    };
    const signal = {
      id: 'sig-1',
      type: 'connection_opportunity' as const,
      strength: 90,
      description: 'Connect now',
      confidence: 80,
      recency: 90,
      opportunity_types: ['experience' as const],
    };

    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow, socialWindow] },
        social_alignment: { signals: [signal] },
        surfacing_rules: { min_context_match: 50, max_opportunities_per_session: 2 },
      }),
    );

    // total_considered includes all 3 candidates before slicing.
    expect(res.total_considered).toBeGreaterThanOrEqual(3);
    // Limited to 2 by max_opportunities_per_session.
    expect(res.opportunities).toHaveLength(2);
    // The 'activity' (Recovery Routine) type must sort ahead of 'place'/'experience'.
    expect(res.opportunities![0].opportunity_type).toBe('activity');
  });
});

// ---------------------------------------------------------------------------
// 8. Storage & dispatch
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — storage & AP-0110 dispatch', () => {
  const recoveryWindow: PredictiveWindow = {
    id: 'win-1',
    type: 'recovery_window',
    horizon: 'today',
    starts_at: '2026-07-28T00:00:00Z',
    ends_at: '2026-07-28T12:00:00Z',
    confidence: 80,
    applicable_domains: ['health_wellbeing'],
    trigger_signals: [],
    explanation: 'Rest window',
    strength: 80,
    is_recurring: false,
  };

  it('inserts surfaced opportunities into contextual_opportunities when a supabase client exists', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({
      contextual_opportunities: [{ count: 0 }, { data: [] }, { error: null }],
      services_catalog: { data: [], error: null },
      products_catalog: { data: [], error: null },
    });
    mockCreateClient.mockReturnValue(supa);

    await surfaceOpportunities(
      baseInput({ predictive_windows: { active_windows: [recoveryWindow] } }),
    );

    const insertCall = supa._callsFor('contextual_opportunities').find((c) =>
      c.calls.some(([m]) => m === 'insert'),
    );
    expect(insertCall).toBeDefined();
    const [, insertArgs] = insertCall!.calls.find(([m]) => m === 'insert')!;
    const records = insertArgs[0];
    expect(records[0]).toMatchObject({
      tenant_id: TENANT,
      user_id: USER,
      session_id: 'session-1',
      status: 'active',
      title: 'Recovery Routine',
    });
  });

  it('never calls insert when there is no supabase client', async () => {
    // no ENVIRONMENT set, no authToken -> supabase stays null throughout
    await surfaceOpportunities(
      baseInput({ predictive_windows: { active_windows: [recoveryWindow] } }),
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('dispatches opportunity.detected exactly once, for the top-ranked opportunity only', async () => {
    const socialWindow: PredictiveWindow = {
      id: 'win-2',
      type: 'social_opportunity',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['social_relationships'],
      trigger_signals: [],
      explanation: 'Social window',
      strength: 90,
      is_recurring: false,
    };

    const res = await surfaceOpportunities(
      baseInput({
        predictive_windows: { active_windows: [recoveryWindow, socialWindow] },
        surfacing_rules: { min_context_match: 50 },
      }),
    );

    expect(res.opportunities!.length).toBeGreaterThan(1);
    expect(mockDispatchEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchEvent).toHaveBeenCalledWith(
      TENANT,
      'opportunity.detected',
      expect.objectContaining({
        user_id: USER,
        opportunity_id: res.opportunities![0].opportunity_id,
        opportunity_type: res.opportunities![0].opportunity_type,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Error handling
// ---------------------------------------------------------------------------

describe('surfaceOpportunities — error handling', () => {
  it('catches a thrown error mid-pipeline, returns SURFACING_FAILED, and emits a .failed OASIS event', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({
      contextual_opportunities: (state: ChainState, idx: number) => {
        if (idx === 0) return { count: 0 }; // fatigue check succeeds
        throw new Error('db unavailable'); // dismissed-cooldown lookup blows up
      },
      services_catalog: { data: [], error: null },
      products_catalog: { data: [], error: null },
    });
    mockCreateClient.mockReturnValue(supa);

    const recoveryWindow: PredictiveWindow = {
      id: 'win-1',
      type: 'recovery_window',
      horizon: 'today',
      starts_at: '2026-07-28T00:00:00Z',
      ends_at: '2026-07-28T12:00:00Z',
      confidence: 80,
      applicable_domains: ['health_wellbeing'],
      trigger_signals: [],
      explanation: 'Rest window',
      strength: 80,
      is_recurring: false,
    };

    const res = await surfaceOpportunities(
      baseInput({ predictive_windows: { active_windows: [recoveryWindow] } }),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBe('SURFACING_FAILED');
    expect(res.message).toBe('db unavailable');
    expect(eventTypes()).toContain('opportunity.surfaced.failed');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', type: 'opportunity.surfaced.failed' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. dismissOpportunity
// ---------------------------------------------------------------------------

describe('dismissOpportunity', () => {
  it('returns NO_DATABASE_CONNECTION with no authToken and not dev-sandbox', async () => {
    const res = await dismissOpportunity('opp-1', USER, TENANT);
    expect(res).toEqual({ ok: false, error: 'NO_DATABASE_CONNECTION' });
  });

  it('updates status=dismissed scoped to id+user+tenant, defaults reason to not_interested, and emits an event', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({ contextual_opportunities: { error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await dismissOpportunity('opp-1', USER, TENANT);
    expect(res.ok).toBe(true);

    const call = supa._callsFor('contextual_opportunities')[0];
    const updateArgs = call.calls.find(([m]) => m === 'update')![1][0];
    expect(updateArgs).toMatchObject({ status: 'dismissed', dismissed_reason: 'not_interested' });
    const eqCalls = call.calls.filter(([m]) => m === 'eq').map(([, a]) => a);
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['id', 'opp-1'],
        ['user_id', USER],
        ['tenant_id', TENANT],
      ]),
    );
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'opportunity.dismissed', status: 'success' }),
    );
  });

  it('propagates a supabase update error', async () => {
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({ contextual_opportunities: { error: { message: 'update failed' } } }),
    );
    const res = await dismissOpportunity('opp-1', USER, TENANT);
    expect(res).toEqual({ ok: false, error: 'update failed' });
  });
});

// ---------------------------------------------------------------------------
// 11. recordEngagement
// ---------------------------------------------------------------------------

describe('recordEngagement', () => {
  it('returns NO_DATABASE_CONNECTION with no authToken and not dev-sandbox', async () => {
    const res = await recordEngagement('opp-1', USER, TENANT, 'viewed');
    expect(res).toEqual({ ok: false, error: 'NO_DATABASE_CONNECTION' });
  });

  it('sets status=engaged only for engagementType=completed, otherwise status=active', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({ contextual_opportunities: { error: null } });
    mockCreateClient.mockReturnValue(supa);

    await recordEngagement('opp-1', USER, TENANT, 'completed');
    let updateArgs = supa._callsFor('contextual_opportunities')[0].calls.find(([m]) => m === 'update')![1][0];
    expect(updateArgs.status).toBe('engaged');

    await recordEngagement('opp-2', USER, TENANT, 'clicked');
    updateArgs = supa._callsFor('contextual_opportunities')[1].calls.find(([m]) => m === 'update')![1][0];
    expect(updateArgs.status).toBe('active');
  });

  it('scopes the update to id+user+tenant', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({ contextual_opportunities: { error: null } });
    mockCreateClient.mockReturnValue(supa);

    await recordEngagement('opp-1', USER, TENANT, 'viewed');
    const eqCalls = supa
      ._callsFor('contextual_opportunities')[0]
      .calls.filter(([m]) => m === 'eq')
      .map(([, a]) => a);
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['id', 'opp-1'],
        ['user_id', USER],
        ['tenant_id', TENANT],
      ]),
    );
  });

  it('propagates a supabase update error', async () => {
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({ contextual_opportunities: { error: { message: 'engage failed' } } }),
    );
    const res = await recordEngagement('opp-1', USER, TENANT, 'viewed');
    expect(res).toEqual({ ok: false, error: 'engage failed' });
  });
});

// ---------------------------------------------------------------------------
// 12. getActiveOpportunities
// ---------------------------------------------------------------------------

describe('getActiveOpportunities', () => {
  it('returns NO_DATABASE_CONNECTION with no authToken and not dev-sandbox', async () => {
    const res = await getActiveOpportunities(USER, TENANT);
    expect(res).toEqual({ ok: false, error: 'NO_DATABASE_CONNECTION' });
  });

  it('scopes the select to tenant_id+user_id+status=active and maps rows to ContextualOpportunity', async () => {
    process.env.ENVIRONMENT = 'development';
    const row = {
      id: 'opp-1',
      opportunity_type: 'activity',
      confidence: 80,
      why_now: 'because',
      relevance_factors: ['goal_match'],
      suggested_action: 'save',
      dismissible: true,
      title: 'Title',
      description: 'Desc',
      external_id: 'ext-1',
      external_type: 'service',
      priority_domain: 'health_wellbeing',
      window_id: undefined,
      guidance_id: undefined,
      alignment_signal_ids: undefined,
      created_at: '2026-07-28T00:00:00Z',
      expires_at: '2026-07-29T00:00:00Z',
    };
    const supa = makeSupabase({ contextual_opportunities: { data: [row], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const res = await getActiveOpportunities(USER, TENANT, 5);
    expect(res.ok).toBe(true);
    expect(res.opportunities).toHaveLength(1);
    expect(res.opportunities![0]).toMatchObject({
      opportunity_id: 'opp-1',
      title: 'Title',
      computed_at: '2026-07-28T00:00:00Z',
    });

    const call = supa._callsFor('contextual_opportunities')[0];
    const eqCalls = call.calls.filter(([m]) => m === 'eq').map(([, a]) => a);
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['tenant_id', TENANT],
        ['user_id', USER],
        ['status', 'active'],
      ]),
    );
    const limitCall = call.calls.find(([m]) => m === 'limit');
    expect(limitCall![1]).toEqual([5]);
  });

  it('a different tenant/user pair produces different eq() scoping (no cross-tenant bleed in the query filters)', async () => {
    process.env.ENVIRONMENT = 'development';
    const supa = makeSupabase({ contextual_opportunities: { data: [], error: null } });
    mockCreateClient.mockReturnValue(supa);

    const otherTenant = '00000000-0000-0000-0000-0000000000t2';
    const otherUser = '00000000-0000-0000-0000-0000000000u2';
    await getActiveOpportunities(otherUser, otherTenant, 3);

    const call = supa._callsFor('contextual_opportunities')[0];
    const eqCalls = call.calls.filter(([m]) => m === 'eq').map(([, a]) => a);
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['tenant_id', otherTenant],
        ['user_id', otherUser],
      ]),
    );
    expect(eqCalls).not.toEqual(expect.arrayContaining([['tenant_id', TENANT]]));
  });

  it('propagates a supabase select error', async () => {
    process.env.ENVIRONMENT = 'development';
    mockCreateClient.mockReturnValue(
      makeSupabase({ contextual_opportunities: { data: null, error: { message: 'select failed' } } }),
    );
    const res = await getActiveOpportunities(USER, TENANT);
    expect(res).toEqual({ ok: false, error: 'select failed' });
  });
});

// ---------------------------------------------------------------------------
// 13. DEFAULT_SURFACING_RULES sanity (regression on the exported constant)
// ---------------------------------------------------------------------------

describe('DEFAULT_SURFACING_RULES', () => {
  it('matches the documented spec defaults', () => {
    expect(DEFAULT_SURFACING_RULES).toEqual({
      min_context_match: 80,
      timing_relevance: 'now',
      max_fatigue_level: 'medium',
      similar_opportunity_cooldown_days: 21,
      max_opportunities_per_session: 3,
      max_opportunities_per_day: 10,
    });
  });
});
