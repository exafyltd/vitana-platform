/**
 * BOOTSTRAP-CONTEXT-CONTRACT — characterization test that LOCKS the context
 * contract.
 *
 * It builds representative `ContextPack` and `UnifiedAwarenessContext` objects
 * (shaped exactly like `context-pack-builder.ts` and the R1 endpoint emit) and
 * asserts the runtime validator accepts them. Because the fixtures are typed as
 * the canonical interfaces, any drift in those interfaces breaks compilation
 * here; any drift in the Zod schema breaks these assertions — so the contract
 * and the real shapes stay in lockstep without modifying either source file.
 */

import {
  validateContextContract,
  assertContextContract,
  contextPackSchema,
  unifiedAwarenessContextSchema,
} from '../src/services/context-contract';
import type { ContextPack } from '../src/types/conversation';
import type { UnifiedAwarenessContext } from '../src/services/awareness-unified-context';

// Minimal-but-complete pack, mirroring the object literal assembled at the end
// of buildContextPack() (context-pack-builder.ts ~line 1071).
function makeMinimalPack(): ContextPack {
  return {
    pack_id: 'pack_abc123',
    pack_hash: '0123456789abcdef',
    assembled_at: new Date().toISOString(),
    assembly_duration_ms: 42,
    identity: {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      user_id: 'a27552a3-0257-4305-8ed0-351a80fd3701',
      role: 'community',
      display_name: 'Dragan',
    },
    session_state: {
      thread_id: '11111111-1111-1111-1111-111111111111',
      channel: 'orb',
      turn_number: 1,
      conversation_start: new Date().toISOString(),
    },
    memory_hits: [],
    knowledge_hits: [],
    web_hits: [],
    active_vtids: [],
    tenant_policies: [],
    tool_health: [],
    retrieval_trace: {
      router_decision: {
        sources_to_query: ['memory_garden'],
        query_order: ['memory_garden'],
        limits: { memory_garden: 8, knowledge_hub: 6, web_search: 4, calendar: 5 },
        matched_rule: 'personal_history',
        decided_at: new Date().toISOString(),
        rationale: 'matched personal_history',
      },
      sources_queried: ['memory_garden'],
      latencies: { memory_garden: 12, knowledge_hub: 0, web_search: 0, calendar: 0 },
      hit_counts: { memory_garden: 0, knowledge_hub: 0, web_search: 0, calendar: 0 },
    },
    token_budget: {
      total_budget: 8000,
      used: 120,
      remaining: 7880,
    },
  };
}

// Fully-populated pack exercising every optional block.
function makeFullPack(): ContextPack {
  const base = makeMinimalPack();
  return {
    ...base,
    memory_hits: [
      {
        id: 'm1',
        category_key: 'health_wellness',
        content: 'Sleeps poorly on Sundays',
        importance: 0.8,
        occurred_at: new Date().toISOString(),
        relevance_score: 0.91,
        source: 'memory_garden',
      },
    ],
    knowledge_hits: [
      {
        id: 'k1',
        title: 'Sleep hygiene',
        snippet: 'Keep a consistent schedule',
        source_path: 'kb/sleep.md',
        relevance_score: 0.7,
      },
    ],
    web_hits: [
      {
        id: 'w1',
        title: 'CDC sleep',
        snippet: '7-9 hours',
        url: 'https://example.com',
        citation: '[1]',
        relevance_score: 0.6,
      },
    ],
    active_vtids: [{ vtid: 'VTID-01225', title: 'Memory', status: 'in_progress', priority: 'high' }],
    tenant_policies: [{ policy_id: 'p1', type: 'pii', value: { redact: true }, enforced: true }],
    tool_health: [{ name: 'memory_garden', available: true, latency_ms: 12, last_checked: new Date().toISOString() }],
    ui_context: { surface: 'orb', screen: 'home', metadata: { foo: 'bar' } },
    relationship_context: ['Fiancee: Ana'],
    calendar_context: {
      today_events: [
        { id: 'e1', title: 'Standup', start_time: '09:00', end_time: '09:15', event_type: 'meeting', status: 'confirmed' },
      ],
      upcoming_events: [],
      gaps_today: [{ start: '10:00', end: '12:00', duration_minutes: 120 }],
      active_role: 'community',
      journey_stage: { wave_name: 'Foundation', day_number: 3, total_days: 35 },
      patterns: ['busy mornings'],
    },
    session_buffer: { turn_count: 2, session_facts_count: 1, formatted_context: 'recent turns...' },
    oasis_context: {
      active_tasks: [{ vtid: 'VTID-01200', title: 'Worker plane', status: 'in_progress', stage: 'worker' }],
      recent_deploys: [{ service: 'gateway', status: 'success', created_at: new Date().toISOString() }],
      pending_approvals_count: 2,
      self_healing_alerts: 0,
      recent_recommendations: [{ title: 'Add cache', status: 'open' }],
    },
    marketplace_context: {
      lifecycle_stage: 'early',
      region_group: 'EU',
      scope_preference: 'regional',
      budget_max_per_product_cents: 5000,
      hard_limitations: {
        allergies: ['peanuts'],
        dietary_restrictions: [],
        contraindications: [],
        current_medications: [],
      },
      active_conditions: [{ key: 'hypertension', source: 'self_reported' }],
      recent_purchases_count: 3,
      upcoming_events_hints: ['birthday'],
      marketplace_picks: [{ product_id: 'prod1', title: 'Magnesium', match_reason: 'sleep support' }],
      wearable_summary_7d: {
        sleep_avg_minutes: 420,
        sleep_deep_pct: 18,
        hrv_avg_ms: 55,
        resting_hr: 58,
        activity_minutes: 200,
        workout_count: 4,
      },
    },
  };
}

function makeUnified(): UnifiedAwarenessContext {
  return {
    identity: {
      user_id: 'a27552a3-0257-4305-8ed0-351a80fd3701',
      tenant_id: '00000000-0000-0000-0000-000000000000',
      first_name: 'Dragan',
      first_name_source: 'memory_facts',
      display_name: 'Dragan Alexander',
      vitana_id: 'VIT-0001',
    },
  };
}

describe('context-contract: ContextPack', () => {
  it('accepts a minimal builder-shaped pack', () => {
    const r = validateContextContract(makeMinimalPack(), 'context_pack');
    expect(r.ok).toBe(true);
    expect(r.issues).toBeUndefined();
    expect(r.data?.pack_id).toBe('pack_abc123');
  });

  it('accepts a fully-populated pack (all optional blocks present)', () => {
    const r = validateContextContract(makeFullPack(), 'context_pack');
    expect(r.ok).toBe(true);
  });

  it('rejects a pack missing a required field', () => {
    const bad = makeMinimalPack() as Record<string, unknown>;
    delete bad.token_budget;
    const r = validateContextContract(bad, 'context_pack');
    expect(r.ok).toBe(false);
    expect(r.issues?.some((i) => i.includes('token_budget'))).toBe(true);
  });

  it('rejects a pack with a wrong-typed field', () => {
    const bad = { ...makeMinimalPack(), assembly_duration_ms: 'fast' } as unknown;
    const r = validateContextContract(bad, 'context_pack');
    expect(r.ok).toBe(false);
    expect(r.issues?.some((i) => i.includes('assembly_duration_ms'))).toBe(true);
  });

  it('rejects an unknown channel value', () => {
    const bad = makeMinimalPack();
    (bad.session_state as { channel: string }).channel = 'sms';
    const r = validateContextContract(bad, 'context_pack');
    expect(r.ok).toBe(false);
  });

  it('schema is directly usable via safeParse', () => {
    expect(contextPackSchema.safeParse(makeMinimalPack()).success).toBe(true);
  });
});

describe('context-contract: UnifiedAwarenessContext', () => {
  it('accepts the R1 endpoint shape', () => {
    const r = validateContextContract(makeUnified(), 'unified_awareness');
    expect(r.ok).toBe(true);
    expect(r.data?.identity.first_name).toBe('Dragan');
  });

  it('accepts null identity fields (pre-resolution)', () => {
    const u = makeUnified();
    u.identity.first_name = null;
    u.identity.first_name_source = 'none';
    u.identity.vitana_id = null;
    expect(validateContextContract(u, 'unified_awareness').ok).toBe(true);
  });

  it('rejects an invalid first_name_source', () => {
    const bad = makeUnified() as { identity: Record<string, unknown> };
    bad.identity.first_name_source = 'guess';
    const r = validateContextContract(bad, 'unified_awareness');
    expect(r.ok).toBe(false);
  });

  it('schema is directly usable via safeParse', () => {
    expect(unifiedAwarenessContextSchema.safeParse(makeUnified()).success).toBe(true);
  });
});

describe('context-contract: assertContextContract feature gate', () => {
  const prev = process.env.FEATURE_CONTEXT_CONTRACT_ASSERT;
  afterEach(() => {
    if (prev === undefined) delete process.env.FEATURE_CONTEXT_CONTRACT_ASSERT;
    else process.env.FEATURE_CONTEXT_CONTRACT_ASSERT = prev;
  });

  it('is a no-op when flag is OFF (default), even on invalid input', () => {
    delete process.env.FEATURE_CONTEXT_CONTRACT_ASSERT;
    expect(() => assertContextContract({ garbage: true }, 'context_pack')).not.toThrow();
  });

  it('throws on invalid input when flag is ON', () => {
    process.env.FEATURE_CONTEXT_CONTRACT_ASSERT = 'true';
    expect(() => assertContextContract({ garbage: true }, 'context_pack')).toThrow(
      /context-contract/,
    );
  });

  it('passes on valid input when flag is ON', () => {
    process.env.FEATURE_CONTEXT_CONTRACT_ASSERT = 'true';
    expect(() => assertContextContract(makeMinimalPack(), 'context_pack')).not.toThrow();
    expect(() => assertContextContract(makeUnified(), 'unified_awareness')).not.toThrow();
  });
});
