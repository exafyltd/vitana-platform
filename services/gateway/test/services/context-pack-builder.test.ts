/**
 * VTID-01216: Context Pack Builder (D3) — Unit Tests
 *
 * Covers `src/services/context-pack-builder.ts`:
 *  - buildContextPack() assembly from Memory Garden + Knowledge Hub sources
 *  - Token/size budgeting (MAX_MEMORY_HITS cap, token_budget shape)
 *  - Empty-source handling (router decision with no sources to query)
 *  - Tenant isolation: a pack built for tenant/user A must never surface
 *    tenant/user B's memory content
 *  - formatContextPackForLLM / extractLanguageFromContextPack /
 *    buildLanguageDirective — pure formatting helpers
 *
 * Mocking strategy mirrors test/intelligence-stack-e2e.test.ts (the only
 * existing test file that already exercises buildContextPack end-to-end):
 * a single global.fetch mock answering every Supabase REST/RPC call the
 * dependency chain makes (memory-broker, memory-facts-service,
 * vtid-ledger-reader, oasis-context-reader, calendar-service, ...), plus
 * jest.mock() at the module boundary for oasis-event-service and
 * knowledge-hub (matching this codebase's established convention).
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
delete process.env.PERPLEXITY_API_KEY;

function restResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type FactRow = {
  id: string;
  fact_key: string;
  fact_value: string;
  entity: string;
  provenance_confidence: number;
  provenance_source: string;
  extracted_at?: string;
};

type MemItemRow = {
  id: string;
  category_key: string;
  content: string;
  importance: number;
  occurred_at: string;
  source: string;
};

// Per-tenant fixture tables, keyed by tenant_id, so the tenant-isolation
// tests can assert cross-tenant leakage never happens.
const FACTS_BY_TENANT: Record<string, FactRow[]> = {};
const ITEMS_BY_TENANT: Record<string, MemItemRow[]> = {};

function tenantFromUrl(url: string): string | null {
  const m = url.match(/tenant_id=eq\.([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];

const mockFetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => {
  const method = options?.method || 'GET';
  fetchCalls.push({ url, method, body: options?.body as string | undefined });

  // system_controls: keep the memory broker on (so EPISODIC goes through
  // the canonical path) and Tier-0 Redis off (irrelevant to these tests).
  if (url.includes('/rest/v1/system_controls')) {
    const keyMatch = url.match(/key=eq\.([^&]+)/);
    const key = keyMatch ? decodeURIComponent(keyMatch[1]) : '';
    return restResponse([
      { key, enabled: key === 'memory_broker_enabled', scope: {}, reason: 'test', expires_at: null },
    ]);
  }

  // ---- RPCs ----
  if (url.includes('/rpc/get_current_facts')) {
    let tenantId: string | null = null;
    try {
      const parsed = options?.body ? JSON.parse(options.body as string) : null;
      tenantId = parsed?.p_tenant_id ?? null;
    } catch {}
    return restResponse(tenantId ? FACTS_BY_TENANT[tenantId] ?? [] : []);
  }
  if (url.includes('/rpc/memory_facts_semantic_search')) return restResponse([]);
  if (url.includes('/rpc/mem_episodes_semantic_search') || url.includes('/rpc/memory_semantic_search')) {
    return restResponse([]);
  }
  if (url.includes('/rest/v1/rpc/')) return restResponse([]);

  // ---- Tables ----
  if (url.includes('/rest/v1/mem_episodes')) return restResponse([]); // ladder falls through to memory_items

  if (url.includes('/rest/v1/memory_items')) {
    if (method === 'GET') {
      const tenantId = tenantFromUrl(url);
      return restResponse(tenantId ? ITEMS_BY_TENANT[tenantId] ?? [] : []);
    }
    return restResponse({ id: 'new-mem-id' }, 201);
  }

  if (url.includes('/rest/v1/memory_facts')) {
    if (method === 'GET') {
      const tenantId = tenantFromUrl(url);
      return restResponse(tenantId ? FACTS_BY_TENANT[tenantId] ?? [] : []);
    }
  }

  if (url.includes('/rest/v1/memory_diary_entries')) return restResponse([]);
  if (url.includes('/rest/v1/relationship_nodes')) return restResponse([]);
  if (url.includes('/rest/v1/relationship_edges')) return restResponse([]);
  if (url.includes('/rest/v1/relationship_signals')) return restResponse([]);
  if (url.includes('/rest/v1/vtid_ledger')) return restResponse([]);
  if (url.includes('/rest/v1/oasis_events')) return restResponse([{ id: 'evt-1' }], 201);

  // Anything else that looks like a PostgREST call: empty result set.
  if (url.includes('/rest/v1/')) return restResponse([]);
  return restResponse({});
});

global.fetch = mockFetch as any;

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockSearchKnowledge = jest.fn().mockResolvedValue({ ok: true, docs: [] });
jest.mock('../../src/services/knowledge-hub', () => ({
  searchKnowledge: (...args: any[]) => mockSearchKnowledge(...args),
}));

import {
  buildContextPack,
  formatContextPackForLLM,
  extractLanguageFromContextPack,
  buildLanguageDirective,
  CONTEXT_PACK_CONFIG,
  BuildContextPackInput,
} from '../../src/services/context-pack-builder';
import { createContextLens } from '../../src/types/context-lens';
import type { ContextPack, RetrievalRouterDecision } from '../../src/types/conversation';

function baseInput(overrides: Partial<BuildContextPackInput> = {}): BuildContextPackInput {
  const lens = createContextLens('tenant-a', 'user-a', { workspace_scope: 'product', active_role: 'community' });
  const router_decision: RetrievalRouterDecision = {
    sources_to_query: ['memory_garden', 'knowledge_hub'],
    query_order: ['memory_garden', 'knowledge_hub'],
    limits: { memory_garden: 25, knowledge_hub: 8, web_search: 6, calendar: 20 },
    matched_rule: 'default',
    decided_at: new Date().toISOString(),
    rationale: 'test',
  };
  return {
    lens,
    query: 'test query',
    channel: 'orb',
    thread_id: 'thread-1',
    turn_number: 1,
    conversation_start: new Date().toISOString(),
    role: 'community',
    router_decision,
    ...overrides,
  };
}

beforeEach(() => {
  fetchCalls.length = 0;
  mockFetch.mockClear();
  mockSearchKnowledge.mockClear();
  mockSearchKnowledge.mockResolvedValue({ ok: true, docs: [] });
  for (const k of Object.keys(FACTS_BY_TENANT)) delete FACTS_BY_TENANT[k];
  for (const k of Object.keys(ITEMS_BY_TENANT)) delete ITEMS_BY_TENANT[k];
});

// =============================================================================
// Assembly from Memory Garden + Knowledge Hub
// =============================================================================

describe('buildContextPack — assembly from sources', () => {
  it('includes knowledge hits mapped from searchKnowledge, capped + truncated to MAX_KNOWLEDGE_HITS/MAX_CONTENT_LENGTH', async () => {
    mockSearchKnowledge.mockResolvedValueOnce({
      ok: true,
      docs: [
        { id: 'doc-1', title: 'Vitana Index Explained', snippet: 'x'.repeat(2000), source: 'kb/index.md', score: 0.9 },
      ],
    });
    const pack = await buildContextPack(baseInput());
    expect(pack.knowledge_hits).toHaveLength(1);
    expect(pack.knowledge_hits[0].id).toBe('doc-1');
    expect(pack.knowledge_hits[0].title).toBe('Vitana Index Explained');
    expect(pack.knowledge_hits[0].snippet.length).toBe(CONTEXT_PACK_CONFIG.MAX_CONTENT_LENGTH);
    expect(pack.retrieval_trace.hit_counts.knowledge_hub).toBe(1);
  });

  it('includes memory hits from memory_items (legacy episodic fallback) for the queried tenant', async () => {
    ITEMS_BY_TENANT['tenant-a'] = [
      { id: 'mem-1', category_key: 'personal', content: 'User lives in Berlin', importance: 80, occurred_at: new Date().toISOString(), source: 'orb_text' },
    ];
    const pack = await buildContextPack(baseInput());
    expect(pack.memory_hits.some(h => h.id === 'mem-1')).toBe(true);
    expect(pack.retrieval_trace.hit_counts.memory_garden).toBeGreaterThan(0);
  });

  it('does not query knowledge_hub when the router decision omits it', async () => {
    const pack = await buildContextPack(baseInput({
      router_decision: {
        sources_to_query: ['memory_garden'],
        query_order: ['memory_garden'],
        limits: { memory_garden: 25, knowledge_hub: 8, web_search: 6, calendar: 20 },
        matched_rule: 'personal_history',
        decided_at: new Date().toISOString(),
        rationale: 'test',
      },
    }));
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
    expect(pack.knowledge_hits).toEqual([]);
    expect(pack.retrieval_trace.hit_counts.knowledge_hub).toBe(0);
  });

  it('records per-source latencies and hit_counts consistent with sources_queried', async () => {
    const pack = await buildContextPack(baseInput());
    expect(pack.retrieval_trace.sources_queried).toEqual(['memory_garden', 'knowledge_hub']);
    expect(pack.retrieval_trace.latencies.memory_garden).toBeGreaterThanOrEqual(0);
    expect(pack.retrieval_trace.latencies.knowledge_hub).toBeGreaterThanOrEqual(0);
    // web_search was not in sources_to_query -> untouched, stays at initial 0
    expect(pack.retrieval_trace.hit_counts.web_search).toBe(0);
  });
});

// =============================================================================
// Token / size budgeting
// =============================================================================

describe('buildContextPack — token/size budgeting', () => {
  it('caps merged memory hits at MAX_MEMORY_HITS even when far more facts are available', async () => {
    const many: FactRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `fact-${i}`,
      fact_key: `custom_fact_${i}`,
      fact_value: `value-${i}`,
      entity: 'self',
      provenance_confidence: 0.8,
      provenance_source: 'user_stated',
    }));
    FACTS_BY_TENANT['tenant-a'] = many;

    const pack = await buildContextPack(baseInput());
    expect(pack.memory_hits.length).toBeLessThanOrEqual(CONTEXT_PACK_CONFIG.MAX_MEMORY_HITS);
    expect(pack.memory_hits.length).toBeGreaterThan(0);
  });

  it('reports a token_budget consistent with total_budget - used', async () => {
    const pack = await buildContextPack(baseInput());
    expect(pack.token_budget.total_budget).toBe(CONTEXT_PACK_CONFIG.TOKEN_BUDGET);
    expect(pack.token_budget.used).toBeGreaterThan(0);
    expect(pack.token_budget.remaining).toBe(pack.token_budget.total_budget - pack.token_budget.used);
  });

  it('used tokens grow with a larger merged memory pool (budgeting reacts to content volume)', async () => {
    const packSmall = await buildContextPack(baseInput());

    FACTS_BY_TENANT['tenant-a'] = Array.from({ length: 20 }, (_, i) => ({
      id: `fact-big-${i}`,
      fact_key: `custom_fact_${i}`,
      fact_value: 'y'.repeat(200),
      entity: 'self',
      provenance_confidence: 0.8,
      provenance_source: 'user_stated',
    }));
    const packLarge = await buildContextPack(baseInput());

    expect(packLarge.token_budget.used).toBeGreaterThan(packSmall.token_budget.used);
  });
});

// =============================================================================
// Empty-source handling
// =============================================================================

describe('buildContextPack — empty source handling', () => {
  it('returns empty memory/knowledge/web hits and zero hit_counts when sources_to_query is empty', async () => {
    // memory_items has data available, but since sources_to_query is empty
    // none of the memory/knowledge/web fetchers should run at all.
    ITEMS_BY_TENANT['tenant-a'] = [
      { id: 'mem-1', category_key: 'personal', content: 'should not appear', importance: 80, occurred_at: new Date().toISOString(), source: 'orb_text' },
    ];

    const pack = await buildContextPack(baseInput({
      router_decision: {
        sources_to_query: [],
        query_order: [],
        limits: { memory_garden: 25, knowledge_hub: 8, web_search: 6, calendar: 20 },
        matched_rule: 'default',
        decided_at: new Date().toISOString(),
        rationale: 'nothing to query',
      },
    }));

    expect(pack.memory_hits).toEqual([]);
    expect(pack.knowledge_hits).toEqual([]);
    expect(pack.web_hits).toEqual([]);
    expect(pack.relationship_context).toBeUndefined();
    expect(pack.retrieval_trace.hit_counts).toEqual({
      memory_garden: 0,
      knowledge_hub: 0,
      web_search: 0,
      calendar: 0,
    });
    expect(mockSearchKnowledge).not.toHaveBeenCalled();

    // The pack itself still gets built successfully (not a hard failure) —
    // identity/session_state/token_budget are always populated.
    expect(pack.identity.tenant_id).toBe('tenant-a');
    expect(pack.token_budget.total_budget).toBe(CONTEXT_PACK_CONFIG.TOKEN_BUDGET);
  });

  it('produces no memory_items GET traffic when memory_garden is not in sources_to_query', async () => {
    await buildContextPack(baseInput({
      router_decision: {
        sources_to_query: ['knowledge_hub'],
        query_order: ['knowledge_hub'],
        limits: { memory_garden: 25, knowledge_hub: 8, web_search: 6, calendar: 20 },
        matched_rule: 'vitana_system',
        decided_at: new Date().toISOString(),
        rationale: 'kb only',
      },
    }));
    const memoryItemGets = fetchCalls.filter(c => c.url.includes('/rest/v1/memory_items') && c.method === 'GET');
    expect(memoryItemGets).toHaveLength(0);
  });
});

// =============================================================================
// Tenant isolation (ALWAYS rule #28: scope memory by tenant + role)
// =============================================================================

describe('buildContextPack — tenant isolation', () => {
  it('a pack built for tenant A never contains tenant B memory content, and vice versa', async () => {
    FACTS_BY_TENANT['tenant-a'] = [
      { id: 'fact-a1', fact_key: 'secret_a', fact_value: 'TENANT_A_SECRET', entity: 'self', provenance_confidence: 0.9, provenance_source: 'user_stated' },
    ];
    FACTS_BY_TENANT['tenant-b'] = [
      { id: 'fact-b1', fact_key: 'secret_b', fact_value: 'TENANT_B_SECRET', entity: 'self', provenance_confidence: 0.9, provenance_source: 'user_stated' },
    ];
    ITEMS_BY_TENANT['tenant-a'] = [
      { id: 'mem-a1', category_key: 'personal', content: 'TENANT_A_MEMORY_ITEM', importance: 80, occurred_at: new Date().toISOString(), source: 'orb_text' },
    ];
    ITEMS_BY_TENANT['tenant-b'] = [
      { id: 'mem-b1', category_key: 'personal', content: 'TENANT_B_MEMORY_ITEM', importance: 80, occurred_at: new Date().toISOString(), source: 'orb_text' },
    ];

    const lensA = createContextLens('tenant-a', 'user-a', { workspace_scope: 'product', active_role: 'community' });
    const lensB = createContextLens('tenant-b', 'user-b', { workspace_scope: 'product', active_role: 'community' });

    const packA = await buildContextPack(baseInput({ lens: lensA }));
    const packB = await buildContextPack(baseInput({ lens: lensB }));

    const packAText = JSON.stringify(packA.memory_hits);
    const packBText = JSON.stringify(packB.memory_hits);

    expect(packAText).toContain('TENANT_A_SECRET');
    expect(packAText).toContain('TENANT_A_MEMORY_ITEM');
    expect(packAText).not.toContain('TENANT_B_SECRET');
    expect(packAText).not.toContain('TENANT_B_MEMORY_ITEM');

    expect(packBText).toContain('TENANT_B_SECRET');
    expect(packBText).toContain('TENANT_B_MEMORY_ITEM');
    expect(packBText).not.toContain('TENANT_A_SECRET');
    expect(packBText).not.toContain('TENANT_A_MEMORY_ITEM');

    // identity block itself must reflect the requesting tenant/user, not a mix
    expect(packA.identity.tenant_id).toBe('tenant-a');
    expect(packA.identity.user_id).toBe('user-a');
    expect(packB.identity.tenant_id).toBe('tenant-b');
    expect(packB.identity.user_id).toBe('user-b');
  });

  it('every memory_items/memory_facts GET call for tenant A carries tenant A\'s id, never tenant B\'s', async () => {
    ITEMS_BY_TENANT['tenant-a'] = [];
    const lensA = createContextLens('tenant-a', 'user-a', { workspace_scope: 'product', active_role: 'community' });
    await buildContextPack(baseInput({ lens: lensA }));

    const tenantScopedCalls = fetchCalls.filter(
      c => (c.url.includes('/rest/v1/memory_items') || c.url.includes('/rest/v1/memory_facts')) && c.method === 'GET',
    );
    expect(tenantScopedCalls.length).toBeGreaterThan(0);
    for (const call of tenantScopedCalls) {
      expect(call.url).toContain('tenant_id=eq.tenant-a');
      expect(call.url).not.toContain('tenant_id=eq.tenant-b');
    }
  });
});

// =============================================================================
// formatContextPackForLLM / extractLanguageFromContextPack / buildLanguageDirective
// =============================================================================

function makeFakePack(overrides: Partial<ContextPack> = {}): ContextPack {
  const now = new Date().toISOString();
  return {
    pack_id: 'pack-1',
    pack_hash: 'hash',
    assembled_at: now,
    assembly_duration_ms: 5,
    identity: { tenant_id: 'tenant-a', user_id: 'user-a', role: 'community', display_name: 'Dragan' },
    session_state: { thread_id: 'thread-1', channel: 'orb', turn_number: 1, conversation_start: now },
    memory_hits: [],
    knowledge_hits: [],
    web_hits: [],
    active_vtids: [],
    tenant_policies: [],
    tool_health: [],
    retrieval_trace: {
      router_decision: {
        sources_to_query: [], query_order: [], limits: { memory_garden: 0, knowledge_hub: 0, web_search: 0, calendar: 0 },
        matched_rule: 'default', decided_at: now, rationale: 'test',
      },
      sources_queried: [],
      latencies: { memory_garden: 0, knowledge_hub: 0, web_search: 0, calendar: 0 },
      hit_counts: { memory_garden: 0, knowledge_hub: 0, web_search: 0, calendar: 0 },
    },
    token_budget: { total_budget: 6000, used: 100, remaining: 5900 },
    ...overrides,
  };
}

describe('formatContextPackForLLM', () => {
  it('renders structured facts (fact: prefixed hits) under <structured_facts>, separate from <memory_context>', () => {
    const pack = makeFakePack({
      memory_hits: [
        { id: 'f1', category_key: 'fact:self', content: 'user_name: Dragan', importance: 100, occurred_at: new Date().toISOString(), source: 'memory_facts', relevance_score: 1 },
        { id: 'm1', category_key: 'personal', content: 'User mentioned Berlin', importance: 60, occurred_at: new Date().toISOString(), source: 'orb_text', relevance_score: 0.5 },
      ],
    });
    const text = formatContextPackForLLM(pack);
    expect(text).toContain('<structured_facts>');
    expect(text).toContain('user_name: Dragan');
    expect(text).toContain('<memory_context>');
    expect(text).toContain('User mentioned Berlin');
    // fact hit must not leak into the raw memory_context block
    const memoryBlock = text.split('<memory_context>')[1];
    expect(memoryBlock).not.toContain('user_name: Dragan');
  });

  it('omits <memory_context> entirely when there are no non-fact hits', () => {
    const pack = makeFakePack({
      memory_hits: [
        { id: 'f1', category_key: 'fact:self', content: 'user_name: Dragan', importance: 100, occurred_at: new Date().toISOString(), source: 'memory_facts', relevance_score: 1 },
      ],
    });
    const text = formatContextPackForLLM(pack);
    expect(text).not.toContain('<memory_context>');
  });

  it('omits knowledge/web/relationship sections when empty, includes them when populated', () => {
    const empty = formatContextPackForLLM(makeFakePack());
    expect(empty).not.toContain('<vitana_knowledge>');
    expect(empty).not.toContain('<web_search_results>');
    expect(empty).not.toContain('<relationship_graph>');

    const populated = formatContextPackForLLM(makeFakePack({
      knowledge_hits: [{ id: 'k1', title: 'Vitana Index', snippet: 'Explains the index.', source_path: 'kb/index.md', relevance_score: 0.9 }],
      web_hits: [{ id: 'w1', title: 'AI news', snippet: 'Something happened.', url: 'https://example.com', citation: '[example]', relevance_score: 0.8 }],
      relationship_context: ['User fiancée: Mariia Maksina (person)'],
    }));
    expect(populated).toContain('<vitana_knowledge>');
    expect(populated).toContain('Vitana Index');
    expect(populated).toContain('<web_search_results>');
    expect(populated).toContain('Source: [example]');
    expect(populated).toContain('<relationship_graph>');
    expect(populated).toContain('Mariia Maksina');
  });

  it('includes active_vtids as a task list when present', () => {
    const text = formatContextPackForLLM(makeFakePack({
      active_vtids: [{ vtid: 'VTID-01216', title: 'Retrieval Router', status: 'in_progress' }],
    }));
    expect(text).toContain('<active_tasks>');
    expect(text).toContain('VTID-01216: Retrieval Router (in_progress)');
  });
});

describe('extractLanguageFromContextPack / buildLanguageDirective', () => {
  it('extracts the preferred language from a fact-prefixed hit', () => {
    const pack = makeFakePack({
      memory_hits: [
        { id: 'f1', category_key: 'fact:self', content: 'preferred_language: German', importance: 100, occurred_at: new Date().toISOString(), source: 'memory_facts', relevance_score: 1 },
      ],
    });
    expect(extractLanguageFromContextPack(pack)).toBe('German');
  });

  it('returns null when no preferred_language fact is present', () => {
    const pack = makeFakePack();
    expect(extractLanguageFromContextPack(pack)).toBeNull();
  });

  it('buildLanguageDirective returns an empty string for null, and a directive for a language name', () => {
    expect(buildLanguageDirective(null)).toBe('');
    const directive = buildLanguageDirective('German');
    expect(directive).toContain('Respond ONLY in German');
  });
});
