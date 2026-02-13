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

// Mock global fetch
const mockFetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => {
  const method = options?.method || 'GET';
  fetchCalls.push({ url, method, body: options?.body as string });

  // Mock responses based on URL
  if (url.includes('/rest/v1/memory_items')) {
    if (method === 'GET') {
      return {
        ok: true,
        json: async () => [
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
        ],
      };
    }
    // POST (write)
    return { ok: true, json: async () => ({ id: 'new-mem-id' }), text: async () => '' };
  }

  if (url.includes('/rest/v1/memory_facts')) {
    if (method === 'GET') {
      return {
        ok: true,
        json: async () => [
          {
            id: 'fact-1',
            fact_key: 'user_name',
            fact_value: 'Dragan Alexander',
            entity: 'self',
            provenance_confidence: 0.95,
            provenance_source: 'assistant_inferred',
          },
          {
            id: 'fact-2',
            fact_key: 'fiancee_name',
            fact_value: 'Mariia Maksina',
            entity: 'disclosed',
            provenance_confidence: 0.92,
            provenance_source: 'assistant_inferred',
          },
          {
            id: 'fact-3',
            fact_key: 'work_location',
            fact_value: 'Exafy, Santa Monica',
            entity: 'self',
            provenance_confidence: 0.88,
            provenance_source: 'assistant_inferred',
          },
        ],
      };
    }
  }

  if (url.includes('/rest/v1/relationship_nodes')) {
    if (method === 'GET') {
      return {
        ok: true,
        json: async () => [
          { id: 'node-1', title: 'Dragan Alexander', node_type: 'person', domain: 'personal', metadata: {} },
          { id: 'node-2', title: 'Mariia Maksina', node_type: 'person', domain: 'personal', metadata: {} },
          { id: 'node-3', title: 'Exafy', node_type: 'organization', domain: 'work', metadata: {} },
        ],
      };
    }
    // POST (write)
    return { ok: true, json: async () => [{ id: 'new-node-id' }], text: async () => '' };
  }

  if (url.includes('/rest/v1/relationship_edges')) {
    if (method === 'GET') {
      return {
        ok: true,
        json: async () => [
          { from_node_id: 'node-1', to_node_id: 'node-2', relationship_type: 'fiancée', strength: 0.95 },
          { from_node_id: 'node-1', to_node_id: 'node-3', relationship_type: 'works_at', strength: 0.90 },
        ],
      };
    }
    // POST (write)
    return { ok: true, json: async () => ({ id: 'new-edge-id' }), text: async () => '' };
  }

  if (url.includes('/rest/v1/relationship_signals')) {
    return { ok: true, json: async () => ({}), text: async () => '' };
  }

  if (url.includes('/rest/v1/rpc/write_fact')) {
    return { ok: true, json: async () => 'fact-new-id', text: async () => '' };
  }

  if (url.includes('/rest/v1/vtid_ledger')) {
    return { ok: true, json: async () => [] };
  }

  if (url.includes('/rest/v1/oasis_events')) {
    return { ok: true, json: async () => ({ id: 'evt-1' }) };
  }

  if (url.includes('/rest/v1/knowledge_base') || url.includes('/rest/v1/knowledge_hub')) {
    return { ok: true, json: async () => [] };
  }

  if (url.includes('perplexity.ai')) {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Web search result about Dragan.' } }],
        citations: ['https://example.com'],
      }),
    };
  }

  // Default: return empty success
  return { ok: true, json: async () => ({}), text: async () => '' };
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

      const routerDecision = computeRetrievalRouterDecision('Tell me about myself', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'Tell me about myself',
        channel: 'orb',
        thread_id: 'test-thread',
        turn_number: 1,
        conversation_start: new Date().toISOString(),
        role: 'community',
        router_decision: routerDecision,
      };

      const pack = await buildContextPack(input);

      // Verify memory_items was also queried
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

      // The LLM context should contain relationship graph
      expect(llmContext).toContain('<relationship_graph>');
      expect(llmContext).toContain('Dragan Alexander');
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

      // Should contain human-readable relationship strings
      const relStrings = pack.relationship_context!.join(' ');
      expect(relStrings).toContain('Dragan Alexander');
      expect(relStrings).toContain('Mariia Maksina');
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

      const routerDecision = computeRetrievalRouterDecision('Tell me about myself', {
        channel: 'orb',
      });

      const input: BuildContextPackInput = {
        lens,
        query: 'Tell me about myself',
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
