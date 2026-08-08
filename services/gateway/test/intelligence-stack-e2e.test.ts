/**
 * VTID-01225: Intelligence & Memory Stack End-to-End Verification Tests
 *
 * Verifies the complete intelligence pipeline from extraction to retrieval:
 * 1. Cognee extraction writes to memory_facts, relationship_nodes, relationship_edges
 * 2. Context pack builder reads from ALL tables (memory_items + memory_facts + relationship_nodes)
 * 3. Retrieval router correctly routes queries to appropriate sources
 * 4. Conversation history is maintained across turns
 * 5. Structured facts and relationship context appear in LLM prompt
 *
 * These tests verify the write/read bridge fix that connects the cognee
 * extraction write path to the context-pack-builder read path.
 */

// Set test environment
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
process.env.COGNEE_EXTRACTOR_URL = 'http://localhost:9999';
process.env.PERPLEXITY_API_KEY = 'test-perplexity-key';

// Track all fetch calls to verify correct tables are queried
const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];

/**
 * Build a Response-like object that satisfies both raw-fetch callers and
 * supabase-js (postgrest-js reads status/statusText/headers/text()).
 */
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

// Structured facts as stored in memory_facts (REST list + get_current_facts RPC)
const FACT_ROWS = [
  {
    id: 'fact-1',
    fact_key: 'user_name',
    fact_value: 'Dragan Alexander',
    fact_value_type: 'text',
    entity: 'self',
    provenance_confidence: 0.95,
    provenance_source: 'assistant_inferred',
    extracted_at: new Date().toISOString(),
  },
  {
    id: 'fact-2',
    fact_key: 'fiancee_name',
    fact_value: 'Mariia Maksina',
    fact_value_type: 'text',
    entity: 'disclosed',
    provenance_confidence: 0.92,
    provenance_source: 'assistant_inferred',
    extracted_at: new Date().toISOString(),
  },
  {
    id: 'fact-3',
    fact_key: 'work_location',
    fact_value: 'Exafy, Santa Monica',
    fact_value_type: 'text',
    entity: 'self',
    provenance_confidence: 0.88,
    provenance_source: 'assistant_inferred',
    extracted_at: new Date().toISOString(),
  },
];

// Legacy episodic rows in memory_items — the memory-broker's EPISODIC block
// falls back to these when mem_episodes is empty (VTID-03156 ladder step 4).
const MEMORY_ITEM_ROWS = [
  {
    id: 'mem-1',
    category_key: 'personal',
    content: 'User: My name is Dragan\nAssistant: Nice to meet you, Dragan!',
    importance: 90,
    occurred_at: new Date().toISOString(),
    source: 'orb_text',
  },
  {
    id: 'mem-2',
    category_key: 'relationships',
    content: 'User mentioned fiancée Mariia Maksina',
    importance: 85,
    occurred_at: new Date().toISOString(),
    source: 'cognee_extraction',
  },
];

// Relationship graph in the AP-0909 shape the broker's NETWORK block reads:
// edges are user-centric (source_id = user), targets resolve via
// relationship_nodes (display column is `title`).
const RELATIONSHIP_EDGE_ROWS = [
  {
    source_type: 'person',
    source_id: 'test-user',
    target_type: 'person',
    target_id: 'node-2',
    edge_type: 'fiancée',
    strength: 95,
    last_interaction_at: new Date().toISOString(),
  },
  {
    source_type: 'person',
    source_id: 'test-user',
    target_type: 'person',
    target_id: 'node-3',
    edge_type: 'works_at',
    strength: 60,
    last_interaction_at: new Date().toISOString(),
  },
];

const RELATIONSHIP_NODE_ROWS = [
  { id: 'node-2', title: 'Mariia Maksina', node_type: 'person' },
  { id: 'node-3', title: 'Exafy', node_type: 'organization' },
];

// Mock global fetch
const mockFetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => {
  const method = options?.method || 'GET';
  fetchCalls.push({ url, method, body: options?.body as string });

  // ---- system_controls: enable ONLY the memory broker (VTID-02026 gate).
  // Everything else (tier0 redis, cognee, …) stays off so the test exercises
  // the canonical broker read path without side quests.
  if (url.includes('/rest/v1/system_controls')) {
    const keyMatch = url.match(/key=eq\.([^&]+)/);
    const key = keyMatch ? decodeURIComponent(keyMatch[1]) : '';
    return restResponse([
      { key, enabled: key === 'memory_broker_enabled', scope: {}, reason: 'test', expires_at: null },
    ]);
  }

  // ---- RPCs (check before plain table names — URLs overlap) ----
  if (url.includes('/rpc/get_current_facts')) {
    return restResponse(FACT_ROWS);
  }
  if (url.includes('/rpc/memory_facts_semantic_search')) {
    return restResponse([]);
  }
  if (url.includes('/rpc/mem_episodes_semantic_search') || url.includes('/rpc/memory_semantic_search')) {
    return restResponse([]);
  }
  if (url.includes('/rpc/write_fact')) {
    return restResponse('fact-new-id');
  }
  if (url.includes('/rest/v1/rpc/')) {
    return restResponse([]);
  }

  // ---- Tables ----
  if (url.includes('/rest/v1/mem_episodes')) {
    // Empty → broker EPISODIC ladder falls through to legacy memory_items.
    return restResponse([]);
  }

  if (url.includes('/rest/v1/memory_items')) {
    if (method === 'GET') {
      return restResponse(MEMORY_ITEM_ROWS);
    }
    return restResponse({ id: 'new-mem-id' }, 201);
  }

  if (url.includes('/rest/v1/memory_facts')) {
    if (method === 'GET') {
      return restResponse(FACT_ROWS);
    }
  }

  if (url.includes('/rest/v1/memory_diary_entries')) {
    return restResponse([]);
  }

  if (url.includes('/rest/v1/relationship_nodes')) {
    if (method === 'GET') {
      return restResponse(RELATIONSHIP_NODE_ROWS);
    }
    return restResponse([{ id: 'new-node-id' }], 201);
  }

  if (url.includes('/rest/v1/relationship_edges')) {
    if (method === 'GET') {
      return restResponse(RELATIONSHIP_EDGE_ROWS);
    }
    return restResponse({ id: 'new-edge-id' }, 201);
  }

  if (url.includes('/rest/v1/relationship_signals')) {
    return restResponse([]);
  }

  if (url.includes('/rest/v1/vtid_ledger')) {
    return restResponse([]);
  }

  if (url.includes('/rest/v1/oasis_events')) {
    return restResponse([{ id: 'evt-1' }], 201);
  }

  if (url.includes('/rest/v1/knowledge_base') || url.includes('/rest/v1/knowledge_hub')) {
    return restResponse([]);
  }

  if (url.includes('perplexity.ai')) {
    return restResponse({
      choices: [{ message: { content: 'Web search result about Dragan.' } }],
      citations: ['https://example.com'],
    });
  }

  // Default: any other PostgREST read returns an empty row set; anything
  // else gets an empty object.
  if (url.includes('/rest/v1/')) {
    return restResponse([]);
  }
  return restResponse({});
});

global.fetch = mockFetch as any;

// Mock OASIS events
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// Mock knowledge hub
jest.mock('../src/services/knowledge-hub', () => ({
  searchKnowledge: jest.fn().mockResolvedValue({ ok: true, docs: [] }),
}));

import { buildContextPack, formatContextPackForLLM, BuildContextPackInput } from '../src/services/context-pack-builder';
import { computeRetrievalRouterDecision } from '../src/services/retrieval-router';
import { createContextLens } from '../src/types/context-lens';

describe('VTID-01225: Intelligence & Memory Stack E2E', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockFetch.mockClear();
  });

  // =========================================================================
  // TEST GROUP 1: Write/Read Bridge Verification
  // =========================================================================

  describe('Write/Read Bridge: Context pack queries all intelligence tables', () => {
    it('should query memory_facts table during context assembly', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('What is my name?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'What is my name?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // Verify memory_facts was queried
      const factsQueries = fetchCalls.filter(c => c.url.includes('memory_facts') && c.method === 'GET');
      expect(factsQueries.length).toBeGreaterThanOrEqual(1);
      expect(factsQueries[0].url).toContain('tenant_id=eq.test-tenant');
      expect(factsQueries[0].url).toContain('user_id=eq.test-user');
    });

    it('should query relationship_nodes table during context assembly', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('Who is my fiancée?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'Who is my fiancée?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // Verify relationship_nodes was queried
      const nodesQueries = fetchCalls.filter(c => c.url.includes('relationship_nodes') && c.method === 'GET');
      expect(nodesQueries.length).toBeGreaterThanOrEqual(1);
    });

    it('should query relationship_edges table during context assembly', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('What relationships do I have?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'What relationships do I have?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // Verify relationship_edges was queried
      const edgesQueries = fetchCalls.filter(c => c.url.includes('relationship_edges') && c.method === 'GET');
      expect(edgesQueries.length).toBeGreaterThanOrEqual(1);
    });

    it('should still query memory_items (legacy) for backward compatibility', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      // NOTE: "Tell me about myself" would match the teach_intent router rule
      // (BOOTSTRAP-TEACH-BEFORE-REDIRECT, "tell me about" → knowledge_hub only,
      // no memory_garden), so use a personal-recall phrasing instead.
      const routerDecision = computeRetrievalRouterDecision('What do you remember about me?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'What do you remember about me?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // Verify memory_items was also queried (the memory-broker's EPISODIC
      // ladder falls back to legacy memory_items when mem_episodes is empty)
      const itemsQueries = fetchCalls.filter(c => c.url.includes('memory_items') && c.method === 'GET');
      expect(itemsQueries.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // TEST GROUP 2: Structured Facts in LLM Context
  // =========================================================================

  describe('Structured facts appear in LLM context', () => {
    it('should include structured_facts section in LLM prompt', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('What is my name?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'What is my name?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);
      const llmContext = formatContextPackForLLM(pack);

      // The LLM context should contain structured facts
      expect(llmContext).toContain('<structured_facts>');
      expect(llmContext).toContain('user_name: Dragan Alexander');
      expect(llmContext).toContain('fiancee_name: Mariia Maksina');
      expect(llmContext).toContain('work_location: Exafy, Santa Monica');
    });

    it('should include relationship_graph section in LLM prompt', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('Who do I know?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'Who do I know?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);
      const llmContext = formatContextPackForLLM(pack);

      // The LLM context should contain the relationship graph. Since
      // VTID-03145 the strings are user-centric ("User <edge>: <name> (<type>)")
      // — the user's own name is not repeated, only the other side of each edge.
      expect(llmContext).toContain('<relationship_graph>');
      expect(llmContext).toContain('Mariia Maksina');
      expect(llmContext).toContain('fiancée');
    });

    it('should include memory_context section for legacy items', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('Remind me of our conversations', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'Remind me of our conversations',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);
      const llmContext = formatContextPackForLLM(pack);

      // Should have memory context with non-fact items
      expect(llmContext).toContain('<memory_context>');
    });
  });

  // =========================================================================
  // TEST GROUP 3: Retrieval Router Decisions
  // =========================================================================

  describe('Retrieval router routes to correct sources', () => {
    it('should route personal recall to memory garden', () => {
      const decision = computeRetrievalRouterDecision("What's my name?", { channel: 'orb' });
      expect(decision.sources_to_query).toContain('memory_garden');
    });

    it('should route relationship questions to memory garden', () => {
      const decision = computeRetrievalRouterDecision('Who is my fiancée?', { channel: 'orb' });
      expect(decision.sources_to_query).toContain('memory_garden');
    });

    it('should route vitana questions to knowledge hub', () => {
      const decision = computeRetrievalRouterDecision('How does the VTID system work?', { channel: 'operator' });
      expect(decision.sources_to_query).toContain('knowledge_hub');
    });

    it('should route current events to web search', () => {
      const decision = computeRetrievalRouterDecision("What's the latest news about AI?", { channel: 'orb' });
      expect(decision.sources_to_query).toContain('web_search');
    });
  });

  // =========================================================================
  // TEST GROUP 4: Memory hits include both facts and legacy items
  // =========================================================================

  describe('Memory hits merge structured facts with legacy items', () => {
    it('should have memory hits from both sources merged and sorted', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('Tell me everything about me', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'Tell me everything about me',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // Should have memory hits from BOTH memory_items AND memory_facts
      expect(pack.memory_hits.length).toBeGreaterThan(0);

      // Check for fact-prefixed category keys (from memory_facts)
      const factHits = pack.memory_hits.filter(h => h.category_key.startsWith('fact:'));
      expect(factHits.length).toBeGreaterThan(0);

      // Check for regular category keys (from memory_items)
      const regularHits = pack.memory_hits.filter(h => !h.category_key.startsWith('fact:'));
      expect(regularHits.length).toBeGreaterThan(0);

      // All hits should be sorted by relevance_score descending
      for (let i = 1; i < pack.memory_hits.length; i++) {
        expect(pack.memory_hits[i - 1].relevance_score).toBeGreaterThanOrEqual(
          pack.memory_hits[i].relevance_score
        );
      }
    });
  });

  // =========================================================================
  // TEST GROUP 5: Relationship context is populated
  // =========================================================================

  describe('Relationship context populated from graph', () => {
    it('should include relationship_context in context pack', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      const routerDecision = computeRetrievalRouterDecision('Who are my connections?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'Who are my connections?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // relationship_context should be populated
      expect(pack.relationship_context).toBeDefined();
      expect(pack.relationship_context!.length).toBeGreaterThan(0);

      // Should contain human-readable, user-centric relationship strings
      // ("User <edge>: <name> (<type>)" — the broker's NETWORK block resolves
      // the other side of each edge; the user's own name is not repeated).
      const relStrings = pack.relationship_context!.join(' ');
      expect(relStrings).toContain('Mariia Maksina');
      expect(relStrings).toContain('Exafy');
      expect(relStrings).toContain('fiancée');
    });
  });

  // =========================================================================
  // TEST GROUP 6: Context pack token budget respects limits
  // =========================================================================

  describe('Token budget management', () => {
    it('should track token usage including facts and relationships', async () => {
      const lens = createContextLens('test-tenant', 'test-user', {
        workspace_scope: 'product',
        active_role: 'community',
      });

      // Personal-recall phrasing so the router includes memory_garden and the
      // token count actually covers facts + relationships (teach-intent
      // phrasings like "tell me about X" skip memory entirely).
      const routerDecision = computeRetrievalRouterDecision('What do you remember about me?', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'What do you remember about me?',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // Token budget should be tracked (TOKEN_BUDGET=6000 in context-pack-builder.ts)
      expect(pack.token_budget).toBeDefined();
      expect(pack.token_budget.total_budget).toBe(6000);
      expect(pack.token_budget.used).toBeGreaterThan(0);
      expect(pack.token_budget.remaining).toBeLessThan(6000);
    });
  });
});
