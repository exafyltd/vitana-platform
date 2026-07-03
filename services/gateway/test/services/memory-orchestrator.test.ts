// BOOTSTRAP-MEMORY-ORCHESTRATOR-MANDATORY — unit tests for the mandatory
// pre-answer memory step.
//
// Contract under test:
//   - buildAssistantMemoryContext():
//       * memory_garden is FORCED into the router decision even when the
//         caller's decision excluded it
//       * returns the sentinel-wrapped prompt block
//       * telemetry counts (facts / diary / episodic / goals / prefs / dnr)
//       * degrades (ok=false, degraded_sources) instead of throwing when a
//         retrieval stream fails
//   - formatMemoryContextForPrompt(): sentinels + sections + self-check;
//     skip_goal_section omits the goals section
//   - wrapLegacyMemoryPreamble(): wraps once, idempotent, empty passthrough
//   - assertMemoryContextInjected(): passes with sentinel; throws for
//     user-facing channels without it; escape hatch + non-enforced channels
//   - estimateAssistantUsedMemory(): lexical floor heuristic

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../src/services/context-pack-builder', () => {
  const actual = jest.requireActual('../../src/services/context-pack-builder');
  return { ...actual, buildContextPack: jest.fn() };
});

jest.mock('../../src/services/memory-broker', () => ({
  getMemoryContext: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

import {
  buildAssistantMemoryContext,
  formatMemoryContextForPrompt,
  wrapLegacyMemoryPreamble,
  assertMemoryContextInjected,
  estimateAssistantUsedMemory,
  MEMORY_CONTEXT_SENTINEL,
  MEMORY_CONTEXT_END_SENTINEL,
} from '../../src/services/memory-orchestrator';
import { buildContextPack } from '../../src/services/context-pack-builder';
import { getMemoryContext } from '../../src/services/memory-broker';
import { getSupabase } from '../../src/lib/supabase';
import { emitOasisEvent } from '../../src/services/oasis-event-service';
import type { ContextPack } from '../../src/types/conversation';

const mockedBuildContextPack = buildContextPack as jest.MockedFunction<typeof buildContextPack>;
const mockedGetMemoryContext = getMemoryContext as jest.MockedFunction<any>;
const mockedGetSupabase = getSupabase as jest.MockedFunction<any>;
const mockedEmit = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    pack_id: 'pack-1',
    pack_hash: 'hash',
    assembled_at: new Date().toISOString(),
    assembly_duration_ms: 10,
    identity: { tenant_id: 't1', user_id: 'u1', role: 'community', display_name: 'Dragan' },
    session_state: {
      thread_id: 'thread-1',
      channel: 'orb',
      turn_number: 1,
      conversation_start: new Date().toISOString(),
    },
    memory_hits: [
      {
        id: 'f1',
        category_key: 'fact:self',
        content: 'user_name: Dragan Alexander',
        importance: 90,
        occurred_at: new Date().toISOString(),
        source: 'cognee_extraction',
        relevance_score: 1,
      },
      {
        id: 'd1',
        category_key: 'diary',
        content: 'Morning walk by the river, felt energized',
        importance: 60,
        occurred_at: new Date().toISOString(),
        source: 'diary',
        relevance_score: 0.8,
      },
      {
        id: 'e1',
        category_key: 'conversation',
        content: 'Asked about improving sleep quality with evening routines',
        importance: 40,
        occurred_at: new Date().toISOString(),
        source: 'mem_episodes',
        relevance_score: 0.7,
      },
    ],
    knowledge_hits: [],
    web_hits: [],
    active_vtids: [],
    tenant_policies: [],
    tool_health: [],
    relationship_context: ['User married to: Maria (person)'],
    session_buffer: { turn_count: 4, session_facts_count: 0, formatted_context: '' },
    retrieval_trace: {
      router_decision: {
        sources_to_query: ['memory_garden'],
        query_order: ['memory_garden'],
        limits: { memory_garden: 12, knowledge_hub: 0, web_search: 0, calendar: 5 },
        matched_rule: 'test',
        decided_at: new Date().toISOString(),
        rationale: 'test',
      },
      sources_queried: ['memory_garden'],
      latencies: { memory_garden: 5, knowledge_hub: 0, web_search: 0, calendar: 0 },
      hit_counts: { memory_garden: 3, knowledge_hub: 0, web_search: 0, calendar: 0 },
    },
    token_budget: { total_budget: 6000, used: 100, remaining: 5900 },
    ...overrides,
  } as ContextPack;
}

/** Chainable supabase query stub that resolves to the given rows. */
function makeSupabaseStub(rowsByTable: Record<string, any[]>) {
  return {
    from: (table: string) => {
      const result = { data: rowsByTable[table] ?? [], error: null };
      const chain: any = {};
      const passthrough = () => chain;
      for (const m of ['select', 'eq', 'order', 'limit', 'gte', 'in']) chain[m] = passthrough;
      chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
      return chain;
    },
  };
}

const BASE_INPUT = {
  tenant_id: 't1',
  user_id: 'u1',
  role: 'community',
  channel: 'orb' as const,
  message: 'how can I sleep better?',
  thread_id: 'thread-1',
};

beforeEach(() => {
  mockedBuildContextPack.mockReset();
  mockedGetMemoryContext.mockReset();
  mockedGetSupabase.mockReset();
  mockedEmit.mockClear();
  delete process.env.MEMORY_ORCHESTRATOR_ENFORCEMENT;

  mockedBuildContextPack.mockResolvedValue(makePack());
  mockedGetSupabase.mockReturnValue(
    makeSupabaseStub({
      life_compass: [{ primary_goal: 'Improve sleep quality', category: 'sleep', is_system_seeded: false }],
      user_preferences: [
        { category: 'lifestyle', preference_key: 'wake_time', preference_value: '06:30' },
      ],
      user_inferred_preferences: [
        { category: 'nutrition', preference_key: 'diet', preference_value: 'vegetarian', confidence: 0.8 },
        { category: 'nutrition', preference_key: 'low_conf', preference_value: 'ignored', confidence: 0.3 },
      ],
    }),
  );
  mockedGetMemoryContext.mockResolvedValue({
    ok: true,
    intent: 'community_intent',
    blocks: {
      GOVERNANCE: {
        kind: 'GOVERNANCE',
        dismissals: [
          {
            recommendation_id: 'r1',
            title: 'Join the morning yoga group',
            domain: 'community',
            status: 'rejected',
            cooldown_until: new Date(Date.now() + 86400000).toISOString(),
            reason: 'rejected',
            source_signal: null,
          },
        ],
        pauses: [],
        source: 'autopilot_recommendations+user_proactive_pause',
        fetched_at: new Date().toISOString(),
      },
    },
    meta: {
      streams_hit: ['GOVERNANCE'],
      latency_ms_per_stream: {},
      total_latency_ms: 5,
      degraded: false,
      pack_size_bytes: 0,
      block_count: 1,
    },
  });
});

// ---------------------------------------------------------------------------
// buildAssistantMemoryContext
// ---------------------------------------------------------------------------

describe('buildAssistantMemoryContext', () => {
  it('returns the sentinel-wrapped block with all sections and correct telemetry', async () => {
    const result = await buildAssistantMemoryContext(BASE_INPUT);

    expect(result.ok).toBe(true);
    expect(result.memory_prompt_block).toContain(MEMORY_CONTEXT_SENTINEL);
    expect(result.memory_prompt_block).toContain(MEMORY_CONTEXT_END_SENTINEL);
    expect(result.memory_prompt_block).toContain('MANDATORY SELF-CHECK');
    expect(result.memory_prompt_block).toContain('Improve sleep quality'); // goal
    expect(result.memory_prompt_block).toContain('wake_time'); // preference
    expect(result.memory_prompt_block).toContain('Join the morning yoga group'); // do-not-repeat

    const t = result.telemetry;
    expect(t.memory_orchestrator_called).toBe(true);
    expect(t.memory_hits).toBe(3);
    expect(t.facts_loaded).toBe(1);
    expect(t.diary_loaded).toBe(1);
    expect(t.episodic_loaded).toBe(1);
    expect(t.goals_loaded).toBe(1);
    expect(t.preferences_loaded).toBe(2); // explicit + high-confidence inferred
    expect(t.relationships_loaded).toBe(1);
    expect(t.dismissed_loaded).toBe(1);
    expect(t.recent_turns_loaded).toBe(4);
    expect(t.memory_injected_to_prompt).toBe(true);
    expect(t.degraded_sources).toEqual([]);
  });

  it('drops low-confidence inferred preferences (< 0.55)', async () => {
    const result = await buildAssistantMemoryContext(BASE_INPUT);
    expect(result.preferences.map((p) => p.key)).toEqual(['wake_time', 'diet']);
  });

  it('FORCES memory_garden into a router decision that excluded it', async () => {
    await buildAssistantMemoryContext({
      ...BASE_INPUT,
      router_decision: {
        sources_to_query: ['knowledge_hub'],
        query_order: ['knowledge_hub'],
        limits: { memory_garden: 0, knowledge_hub: 8, web_search: 0, calendar: 0 },
        matched_rule: 'general_knowledge',
        decided_at: new Date().toISOString(),
        rationale: 'knowledge only',
      },
    });

    const passedDecision = mockedBuildContextPack.mock.calls[0][0].router_decision;
    expect(passedDecision.sources_to_query).toContain('memory_garden');
    expect(passedDecision.limits.memory_garden).toBeGreaterThanOrEqual(8);
  });

  it('degrades instead of throwing when buildContextPack fails, and still injects the sentinel', async () => {
    mockedBuildContextPack.mockRejectedValue(new Error('supabase down'));

    const result = await buildAssistantMemoryContext(BASE_INPUT);

    expect(result.ok).toBe(false);
    expect(result.telemetry.degraded_sources).toContain('context_pack');
    expect(result.telemetry.memory_hits).toBe(0);
    // The block still carries goals/prefs + the self-check so the reply is
    // still governed by the memory contract.
    expect(result.memory_prompt_block).toContain(MEMORY_CONTEXT_SENTINEL);
    expect(result.memory_prompt_block).toContain('Improve sleep quality');
  });

  it('marks governance degraded when the broker is disabled', async () => {
    mockedGetMemoryContext.mockResolvedValue({ ok: false, error: 'memory_broker_disabled', blocks: {}, intent: 'community_intent', meta: {} });
    const result = await buildAssistantMemoryContext(BASE_INPUT);
    expect(result.telemetry.degraded_sources).toContain('governance');
    expect(result.do_not_repeat).toEqual([]);
  });

  it('never loads or renders Life Compass goals for developer/admin roles (VTID-03183)', async () => {
    for (const role of ['developer', 'admin']) {
      const result = await buildAssistantMemoryContext({ ...BASE_INPUT, role });
      expect(result.goals).toEqual([]);
      expect(result.telemetry.goals_loaded).toBe(0);
      expect(result.memory_prompt_block).not.toContain('<user_goals>');
      expect(result.memory_prompt_block).not.toContain('Improve sleep quality');
    }
  });

  it('emits the context_built OASIS event with telemetry payload', async () => {
    await buildAssistantMemoryContext(BASE_INPUT);
    const call = mockedEmit.mock.calls.find(
      (c) => c[0].type === 'memory.orchestrator.context_built',
    );
    expect(call).toBeDefined();
    expect((call![0].payload as any).memory_hits).toBe(3);
    expect((call![0].payload as any).memory_injected_to_prompt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatMemoryContextForPrompt
// ---------------------------------------------------------------------------

describe('formatMemoryContextForPrompt', () => {
  it('omits the goals section when skip_goal_section is set (Life Compass block owns goals)', () => {
    const block = formatMemoryContextForPrompt({
      context_pack: makePack(),
      goals: [{ primary_goal: 'Improve sleep quality', category: 'sleep' }],
      preferences: [],
      do_not_repeat: [],
      skip_goal_section: true,
    });
    expect(block).not.toContain('<user_goals>');
    expect(block).toContain(MEMORY_CONTEXT_SENTINEL);
    expect(block).toContain('MANDATORY SELF-CHECK');
  });

  it('omits empty sections entirely', () => {
    const block = formatMemoryContextForPrompt({
      context_pack: makePack(),
      goals: [],
      preferences: [],
      do_not_repeat: [],
    });
    expect(block).not.toContain('<user_goals>');
    expect(block).not.toContain('<user_preferences>');
    expect(block).not.toContain('<do_not_repeat>');
  });

  it('states that memory enriches and never overrides the proactive/persona directives', () => {
    const block = formatMemoryContextForPrompt({
      context_pack: makePack(),
      goals: [],
      preferences: [],
      do_not_repeat: [],
    });
    expect(block).toMatch(/complement.*never override/is);
    expect(block).toMatch(/Do NOT recite memory back/i);
  });
});

// ---------------------------------------------------------------------------
// wrapLegacyMemoryPreamble
// ---------------------------------------------------------------------------

describe('wrapLegacyMemoryPreamble', () => {
  it('wraps a legacy preamble in sentinels + self-check', () => {
    const wrapped = wrapLegacyMemoryPreamble('## USER MEMORY\n- likes hiking');
    expect(wrapped).toContain(MEMORY_CONTEXT_SENTINEL);
    expect(wrapped).toContain(MEMORY_CONTEXT_END_SENTINEL);
    expect(wrapped).toContain('- likes hiking');
    expect(wrapped).toContain('MANDATORY SELF-CHECK');
  });

  it('is idempotent', () => {
    const once = wrapLegacyMemoryPreamble('memory body');
    const twice = wrapLegacyMemoryPreamble(once);
    expect(twice).toBe(once);
  });

  it('passes empty input through unchanged', () => {
    expect(wrapLegacyMemoryPreamble('')).toBe('');
    expect(wrapLegacyMemoryPreamble('   ')).toBe('   ');
  });
});

// ---------------------------------------------------------------------------
// assertMemoryContextInjected
// ---------------------------------------------------------------------------

describe('assertMemoryContextInjected', () => {
  const meta = { channel: 'orb', caller: 'test' };

  it('passes when the sentinel is present', () => {
    expect(() =>
      assertMemoryContextInjected(`persona\n${MEMORY_CONTEXT_SENTINEL}\nstuff`, meta),
    ).not.toThrow();
  });

  it('THROWS for user-facing channels when the sentinel is missing', () => {
    expect(() => assertMemoryContextInjected('You are Vitana.', meta)).toThrow(
      /MEMORY_ORCHESTRATOR_SKIPPED/,
    );
    expect(() =>
      assertMemoryContextInjected('You are Vitana.', { channel: 'operator', caller: 'test' }),
    ).toThrow(/MEMORY_ORCHESTRATOR_SKIPPED/);
  });

  it('does not throw for non-user-facing channels (but emits the bypass event)', () => {
    expect(() =>
      assertMemoryContextInjected('You are Vitana.', {
        channel: 'developer_assistant',
        caller: 'test',
      }),
    ).not.toThrow();
    expect(
      mockedEmit.mock.calls.some((c) => c[0].type === 'memory.orchestrator.bypass_detected'),
    ).toBe(true);
  });

  it('respects the MEMORY_ORCHESTRATOR_ENFORCEMENT=off escape hatch', () => {
    process.env.MEMORY_ORCHESTRATOR_ENFORCEMENT = 'off';
    expect(() => assertMemoryContextInjected('You are Vitana.', meta)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// estimateAssistantUsedMemory
// ---------------------------------------------------------------------------

describe('estimateAssistantUsedMemory', () => {
  const memory = {
    context_pack: makePack(),
    goals: [{ primary_goal: 'Improve sleep quality', category: 'sleep' }],
    preferences: [
      { category: 'lifestyle', key: 'wake_time', value: '06:30', source: 'explicit' as const },
    ],
  };

  it('detects a reply that references memory (goal term)', () => {
    expect(
      estimateAssistantUsedMemory(memory, 'Da dein Fokus auf besserem Schlaf liegt: sleep quality first.'),
    ).toBe(true);
  });

  it('detects a reply that references a fact value (name)', () => {
    expect(estimateAssistantUsedMemory(memory, 'Guten Morgen, Dragan!')).toBe(true);
  });

  it('returns false for a generic reply with no memory reference', () => {
    expect(estimateAssistantUsedMemory(memory, 'OK.')).toBe(false);
    expect(estimateAssistantUsedMemory(memory, '')).toBe(false);
  });
});
