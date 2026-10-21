/**
 * VTID-01216: Retrieval Router (D2) — Unit Tests
 *
 * Covers `src/services/retrieval-router.ts`:
 *  - Rule matching by keyword and by regex pattern
 *  - Priority ordering when multiple rules could match the same query
 *  - Routing decision output shape (sources, query_order, limits, matched_rule, rationale)
 *  - Default/fallback behavior when nothing matches
 *  - force_sources override + limit_overrides clamping
 *  - getRoutingRuleNames / getRoutingRuleByName / analyzeQueryRouting helpers
 *  - logRetrievalRouterDecision → emitOasisEvent wiring + error swallowing
 *
 * Mocks: oasis-event-service (module boundary), matching the convention in
 * test/memory.test.ts and test/intelligence-stack-e2e.test.ts.
 */

process.env.NODE_ENV = 'test';

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

import {
  computeRetrievalRouterDecision,
  logRetrievalRouterDecision,
  getRoutingRuleNames,
  getRoutingRuleByName,
  analyzeQueryRouting,
  RETRIEVAL_CONFIG,
} from '../../src/services/retrieval-router';

// The router module sorts its internal ROUTING_RULES array in place on the
// first call to computeRetrievalRouterDecision (stateful side effect of
// `.sort()` on a module-level const). Force that sort to happen before any
// order-sensitive assertions run, so tests don't depend on call order.
beforeAll(() => {
  computeRetrievalRouterDecision('warm up the sort', { channel: 'orb' });
});

const ALL_RULE_NAMES = [
  'vitana_system',
  'nav_intent',
  'teach_intent',
  'teach_then_nav_intent',
  'personal_index',
  'personal_history',
  'health_personal',
  'external_current',
  'general_knowledge',
  'default',
];

describe('computeRetrievalRouterDecision — rule matching', () => {
  it('matches vitana_system via a VTID pattern (isolated from all other rules)', () => {
    const decision = computeRetrievalRouterDecision('What is VTID-01216?', { channel: 'operator' });
    expect(decision.matched_rule).toBe('vitana_system');
    expect(decision.sources_to_query[0]).toBe('knowledge_hub');
  });

  it('matches vitana_system via a bare keyword ("oasis")', () => {
    const decision = computeRetrievalRouterDecision('how does oasis work', { channel: 'operator' });
    expect(decision.matched_rule).toBe('vitana_system');
  });

  it('matches nav_intent for a clear "go to X" navigation phrase', () => {
    const decision = computeRetrievalRouterDecision('go to the next section', { channel: 'orb' });
    expect(decision.matched_rule).toBe('nav_intent');
    expect(decision.sources_to_query).toEqual(['knowledge_hub']);
  });

  it('matches teach_intent for an explicit "explain" request', () => {
    const decision = computeRetrievalRouterDecision('explain how that works', { channel: 'orb' });
    expect(decision.matched_rule).toBe('teach_intent');
  });

  it('matches teach_then_nav_intent for an ambiguous "how can I <verb>" phrase', () => {
    // Deliberately avoids the nutrition/hydration/exercise/sleep/mental words
    // that personal_index (priority 95, checked first) also keys on.
    const decision = computeRetrievalRouterDecision('how can i sync my data', { channel: 'orb' });
    expect(decision.matched_rule).toBe('teach_then_nav_intent');
  });

  it('matches personal_index for a "how is my X" per-pillar query', () => {
    const decision = computeRetrievalRouterDecision('how is my sleep', { channel: 'orb' });
    expect(decision.matched_rule).toBe('personal_index');
    expect(decision.sources_to_query[0]).toBe('memory_garden');
  });

  it('matches personal_history for a "remember" recall query', () => {
    const decision = computeRetrievalRouterDecision('remember my birthday', { channel: 'orb' });
    expect(decision.matched_rule).toBe('personal_history');
    expect(decision.sources_to_query[0]).toBe('memory_garden');
  });

  it('matches health_personal for a personal health data query', () => {
    const decision = computeRetrievalRouterDecision('my blood pressure is high today', { channel: 'orb' });
    expect(decision.matched_rule).toBe('health_personal');
    expect(decision.sources_to_query[0]).toBe('memory_garden');
  });

  it('matches external_current for a time-sensitive weather query', () => {
    const decision = computeRetrievalRouterDecision("what's the current weather", { channel: 'orb' });
    expect(decision.matched_rule).toBe('external_current');
    expect(decision.sources_to_query[0]).toBe('web_search');
  });

  it('matches general_knowledge for a generic how-to query', () => {
    const decision = computeRetrievalRouterDecision('how to change a tire', { channel: 'orb' });
    expect(decision.matched_rule).toBe('general_knowledge');
    expect(decision.sources_to_query[0]).toBe('knowledge_hub');
  });

  it('falls back to default when nothing matches', () => {
    const decision = computeRetrievalRouterDecision('xyzzy plugh foobar', { channel: 'orb' });
    expect(decision.matched_rule).toBe('default');
    expect(decision.sources_to_query).toEqual(['memory_garden', 'knowledge_hub']);
  });

  it('is case-insensitive and trims whitespace (normalizes before matching)', () => {
    const decision = computeRetrievalRouterDecision('  REMEMBER MY BIRTHDAY  ', { channel: 'orb' });
    expect(decision.matched_rule).toBe('personal_history');
  });
});

describe('computeRetrievalRouterDecision — priority ordering', () => {
  it('vitana_system (100) wins over general_knowledge (50) when both patterns could match', () => {
    // "what is vitana" matches vitana_system's pattern AND (as a substring)
    // could plausibly be read as a generic "what is X" query. The higher
    // priority rule must win because the loop iterates priority-DESC and
    // breaks at first match.
    const decision = computeRetrievalRouterDecision('what is vitana', { channel: 'orb' });
    expect(decision.matched_rule).toBe('vitana_system');
  });

  it('vitana_system (100) wins over teach_intent (93) when a query contains both a KB keyword and a teach phrase', () => {
    // "tell me about" is a teach_intent trigger; "vitana" is a vitana_system
    // keyword. vitana_system must win purely on priority.
    const decision = computeRetrievalRouterDecision('tell me about vitana', { channel: 'orb' });
    expect(decision.matched_rule).toBe('vitana_system');
  });

  it('personal_index (95) wins over personal_history (90) when both could match', () => {
    // "remember" is a personal_history keyword (90); "my score" is a
    // personal_index keyword (95). personal_index must win on priority.
    const decision = computeRetrievalRouterDecision('remember my score', { channel: 'orb' });
    expect(decision.matched_rule).toBe('personal_index');
  });

  it('health_personal (85) wins over general_knowledge (50) for a query matching both', () => {
    // "how am i doing" is a health_personal pattern; it also loosely reads as
    // a general knowledge phrasing, but health_personal's higher priority
    // must win.
    const decision = computeRetrievalRouterDecision('how am i doing', { channel: 'orb' });
    expect(decision.matched_rule).toBe('health_personal');
  });
});

describe('computeRetrievalRouterDecision — output shape', () => {
  it('returns the full RetrievalRouterDecision shape', () => {
    const decision = computeRetrievalRouterDecision('remember my birthday', { channel: 'orb' });
    expect(decision).toEqual(
      expect.objectContaining({
        sources_to_query: expect.any(Array),
        query_order: expect.any(Array),
        limits: expect.objectContaining({
          memory_garden: expect.any(Number),
          knowledge_hub: expect.any(Number),
          web_search: expect.any(Number),
          calendar: expect.any(Number),
        }),
        matched_rule: expect.any(String),
        decided_at: expect.any(String),
        rationale: expect.any(String),
      }),
    );
    // decided_at must be a valid ISO timestamp
    expect(Number.isNaN(Date.parse(decision.decided_at))).toBe(false);
  });

  it('query_order equals sources_to_query (same computed array)', () => {
    const decision = computeRetrievalRouterDecision('my blood pressure today', { channel: 'orb' });
    expect(decision.query_order).toEqual(decision.sources_to_query);
  });

  it('rationale matches the matched rule\'s documented rationale', () => {
    const decision = computeRetrievalRouterDecision('remember my birthday', { channel: 'orb' });
    const rule = getRoutingRuleByName('personal_history');
    expect(decision.rationale).toBe(rule?.rationale);
  });

  it('sources_to_query has no duplicates for a normal (non-forced) decision', () => {
    const decision = computeRetrievalRouterDecision('my blood pressure today', { channel: 'orb' });
    const unique = new Set(decision.sources_to_query);
    expect(unique.size).toBe(decision.sources_to_query.length);
  });

  it('calendar limit is always 20 regardless of the matched rule', () => {
    const d1 = computeRetrievalRouterDecision('remember my birthday', { channel: 'orb' });
    const d2 = computeRetrievalRouterDecision('what is vitana', { channel: 'orb' });
    const d3 = computeRetrievalRouterDecision('xyzzy plugh foobar', { channel: 'orb' });
    expect(d1.limits.calendar).toBe(20);
    expect(d2.limits.calendar).toBe(20);
    expect(d3.limits.calendar).toBe(20);
  });

  it('default limits match RETRIEVAL_CONFIG.DEFAULT_LIMITS when no overrides are given', () => {
    const decision = computeRetrievalRouterDecision('xyzzy plugh foobar', { channel: 'orb' });
    expect(decision.limits.memory_garden).toBe(RETRIEVAL_CONFIG.DEFAULT_LIMITS.memory_garden);
    expect(decision.limits.knowledge_hub).toBe(RETRIEVAL_CONFIG.DEFAULT_LIMITS.knowledge_hub);
    expect(decision.limits.web_search).toBe(RETRIEVAL_CONFIG.DEFAULT_LIMITS.web_search);
  });
});

describe('computeRetrievalRouterDecision — force_sources override', () => {
  it('overrides the matched rule\'s sources when force_sources is provided', () => {
    const decision = computeRetrievalRouterDecision('remember my birthday', {
      channel: 'orb',
      force_sources: ['web_search'],
    });
    // matched_rule reflects what the text WOULD have matched (rule matching
    // still runs), but sources_to_query reflects the forced override.
    expect(decision.matched_rule).toBe('personal_history');
    expect(decision.sources_to_query).toEqual(['web_search']);
    expect(decision.query_order).toEqual(['web_search']);
  });

  it('does NOT dedupe forced sources — unlike the matched-rule path, force_sources ships as given', () => {
    // Contrast with the "no duplicates" assertion for the non-forced path
    // above: computeRetrievalRouterDecision only dedupes the sources it
    // derives from the matched rule (primary + secondary), not an explicit
    // force_sources override.
    const decision = computeRetrievalRouterDecision('xyzzy plugh foobar', {
      channel: 'orb',
      force_sources: ['memory_garden', 'memory_garden', 'knowledge_hub'],
    });
    expect(decision.sources_to_query).toEqual(['memory_garden', 'memory_garden', 'knowledge_hub']);
  });

  it('an empty force_sources array is falsy-length and falls through to the matched rule\'s sources', () => {
    const decision = computeRetrievalRouterDecision('remember my birthday', {
      channel: 'orb',
      force_sources: [],
    });
    expect(decision.sources_to_query).toEqual(['memory_garden', 'knowledge_hub']);
  });
});

describe('computeRetrievalRouterDecision — limit_overrides clamping', () => {
  it('clamps an override above MAX_LIMITS down to the max', () => {
    const decision = computeRetrievalRouterDecision('xyzzy plugh foobar', {
      channel: 'orb',
      limit_overrides: { memory_garden: 999 },
    });
    expect(decision.limits.memory_garden).toBe(RETRIEVAL_CONFIG.MAX_LIMITS.memory_garden);
  });

  it('clamps an override below MIN_LIMITS up to the min', () => {
    const decision = computeRetrievalRouterDecision('xyzzy plugh foobar', {
      channel: 'orb',
      limit_overrides: { memory_garden: 0 },
    });
    expect(decision.limits.memory_garden).toBe(RETRIEVAL_CONFIG.MIN_LIMITS.memory_garden);
  });

  it('accepts an in-range override unchanged', () => {
    const decision = computeRetrievalRouterDecision('xyzzy plugh foobar', {
      channel: 'orb',
      limit_overrides: { web_search: 3 },
    });
    expect(decision.limits.web_search).toBe(3);
  });

  it('knowledge_hub MIN_LIMITS allows 0 (unlike memory_garden which floors at 5)', () => {
    const decision = computeRetrievalRouterDecision('xyzzy plugh foobar', {
      channel: 'orb',
      limit_overrides: { knowledge_hub: 0 },
    });
    expect(decision.limits.knowledge_hub).toBe(0);
  });
});

describe('getRoutingRuleNames / getRoutingRuleByName', () => {
  it('returns exactly the documented set of rule names (order-agnostic — the module sorts in place)', () => {
    const names = getRoutingRuleNames();
    expect(names).toHaveLength(ALL_RULE_NAMES.length);
    expect([...names].sort()).toEqual([...ALL_RULE_NAMES].sort());
  });

  it('getRoutingRuleByName returns the rule with correct priority + sources for a known rule', () => {
    const rule = getRoutingRuleByName('health_personal');
    expect(rule).toBeDefined();
    expect(rule?.priority).toBe(85);
    expect(rule?.primary_source).toBe('memory_garden');
    expect(rule?.secondary_sources).toEqual(['knowledge_hub', 'web_search']);
  });

  it('getRoutingRuleByName returns undefined for an unknown rule name', () => {
    expect(getRoutingRuleByName('not_a_real_rule')).toBeUndefined();
  });

  it('the default rule has priority 0 and empty patterns/keywords (true catch-all)', () => {
    const rule = getRoutingRuleByName('default');
    expect(rule?.priority).toBe(0);
    expect(rule?.patterns).toEqual([]);
    expect(rule?.keywords).toEqual([]);
  });
});

describe('analyzeQueryRouting', () => {
  it('returns matches sorted by priority descending, always including default', () => {
    const matches = analyzeQueryRouting('remember my birthday');
    expect(matches.length).toBeGreaterThan(0);
    // default is always present (unconditional match in the source loop)
    expect(matches.some(m => m.rule === 'default' && m.matched_by === 'default')).toBe(true);
    // sorted descending by priority
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].priority).toBeGreaterThanOrEqual(matches[i].priority);
    }
    // the top match for this query should be personal_history, triggered by
    // its /(remember|recall|...) (about )?(my|i)/ pattern (not a bare keyword)
    expect(matches[0].rule).toBe('personal_history');
    expect(matches[0].matched_by).toBe('pattern');
  });

  it('reports matched_by "pattern" when a regex (not a bare keyword) triggers the rule', () => {
    const matches = analyzeQueryRouting('What is VTID-01216?');
    const top = matches.find(m => m.rule === 'vitana_system');
    expect(top?.matched_by).toBe('pattern');
  });

  it('for a query matching nothing, only the default entry is returned', () => {
    const matches = analyzeQueryRouting('xyzzy plugh foobar');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ rule: 'default', matched_by: 'default', priority: 0 });
  });
});

describe('logRetrievalRouterDecision', () => {
  beforeEach(() => {
    mockEmitOasisEvent.mockClear();
    mockEmitOasisEvent.mockResolvedValue({ ok: true });
  });

  it('emits an OASIS event with the router decision payload', async () => {
    const decision = computeRetrievalRouterDecision('remember my birthday', { channel: 'orb' });
    await logRetrievalRouterDecision(decision, {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      thread_id: 'thread-1',
      channel: 'orb',
      query: 'remember my birthday',
    });

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.vtid).toBe('VTID-01216');
    expect(call.type).toBe('conversation.retrieval.router_decision');
    expect(call.source).toBe('conversation-orb');
    expect(call.payload.tenant_id).toBe('tenant-a');
    expect(call.payload.user_id).toBe('user-a');
    expect(call.payload.thread_id).toBe('thread-1');
    expect(call.payload.decision.matched_rule).toBe('personal_history');
    expect(call.payload.decision.sources_to_query).toEqual(decision.sources_to_query);
  });

  it('truncates the query preview to 100 chars', async () => {
    const longQuery = 'remember my birthday ' + 'x'.repeat(200);
    const decision = computeRetrievalRouterDecision(longQuery, { channel: 'orb' });
    await logRetrievalRouterDecision(decision, {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      thread_id: 'thread-1',
      channel: 'orb',
      query: longQuery,
    });
    const call = mockEmitOasisEvent.mock.calls[0][0];
    expect(call.payload.query_preview.length).toBe(100);
  });

  it('swallows emitOasisEvent failures without throwing (fire-and-forget logging)', async () => {
    mockEmitOasisEvent.mockRejectedValueOnce(new Error('oasis unavailable'));
    const decision = computeRetrievalRouterDecision('remember my birthday', { channel: 'orb' });
    await expect(
      logRetrievalRouterDecision(decision, {
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        thread_id: 'thread-1',
        channel: 'orb',
        query: 'remember my birthday',
      }),
    ).resolves.toBeUndefined();
  });
});
