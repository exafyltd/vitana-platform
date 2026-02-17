/**
 * VTID-01225: Inline Fact Extractor Unit Tests
 *
 * Tests the Gemini-based inline fact extractor that serves as Cognee fallback.
 * Verifies:
 * 1. parseFactsResponse handles all LLM output formats (clean JSON, markdown, mixed)
 * 2. persistFact calls write_fact() RPC with correct schema
 * 3. extractAndPersistFacts orchestrates extraction + persistence correctly
 * 4. isInlineExtractionAvailable returns correct availability status
 * 5. Edge cases: empty input, short messages, malformed JSON, etc.
 */

// Set test environment BEFORE imports
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';

// Track fetch calls
const fetchCalls: Array<{ url: string; method: string; body?: any }> = [];

// Controllable Vertex AI response - changed per test
let vertexResponseText = JSON.stringify([
  { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text' },
  { fact_key: 'fiancee_name', fact_value: 'Mariia', entity: 'disclosed', fact_value_type: 'text' },
]);
let vertexShouldFail = false;

// Mock VertexAI BEFORE any imports
jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockImplementation(async () => {
        if (vertexShouldFail) {
          throw new Error('Vertex AI mock failure');
        }
        return {
          response: {
            candidates: [{
              content: {
                parts: [{ text: vertexResponseText }],
              },
            }],
          },
        };
      }),
    }),
  })),
}));

// Mock fetch globally
const mockFetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => {
  const method = options?.method || 'GET';
  const body = options?.body ? JSON.parse(options.body as string) : undefined;
  fetchCalls.push({ url, method, body });

  // Mock Gemini API response (fallback when Vertex fails)
  if (url.includes('generativelanguage.googleapis.com')) {
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify([
                { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text' },
                { fact_key: 'user_residence', fact_value: 'Aachen', entity: 'self', fact_value_type: 'text' },
              ]),
            }],
          },
        }],
      }),
    };
  }

  // Mock write_fact RPC
  if (url.includes('/rest/v1/rpc/write_fact')) {
    return {
      ok: true,
      json: async () => 'fact-uuid-123',
    };
  }

  return { ok: true, json: async () => ({}), text: async () => '' };
});

global.fetch = mockFetch as any;

import { extractAndPersistFacts, isInlineExtractionAvailable } from '../src/services/inline-fact-extractor';

describe('VTID-01225: Inline Fact Extractor', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockFetch.mockClear();
    // Reset vertex defaults
    vertexResponseText = JSON.stringify([
      { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text' },
      { fact_key: 'fiancee_name', fact_value: 'Mariia', entity: 'disclosed', fact_value_type: 'text' },
    ]);
    vertexShouldFail = false;
  });

  // =========================================================================
  // TEST GROUP 1: isInlineExtractionAvailable
  // =========================================================================

  describe('isInlineExtractionAvailable', () => {
    it('should return true when LLM and Supabase are configured', () => {
      expect(isInlineExtractionAvailable()).toBe(true);
    });
  });

  // =========================================================================
  // TEST GROUP 2: extractAndPersistFacts - Happy Path
  // =========================================================================

  describe('extractAndPersistFacts - extraction and persistence', () => {
    it('should extract facts from conversation text and call write_fact RPC', async () => {
      await extractAndPersistFacts({
        conversationText: 'User: My name is Dragan and I live in Aachen.\nAssistant: Nice to meet you!',
        tenant_id: 'tenant-123',
        user_id: 'user-456',
        session_id: 'session-789',
      });

      // Should have called write_fact for each extracted fact (2 facts from Vertex mock)
      const writeFactCalls = fetchCalls.filter(c => c.url.includes('write_fact'));
      expect(writeFactCalls.length).toBe(2);

      // Verify write_fact call has correct schema
      const firstWrite = writeFactCalls[0];
      expect(firstWrite.method).toBe('POST');
      expect(firstWrite.body).toHaveProperty('p_tenant_id', 'tenant-123');
      expect(firstWrite.body).toHaveProperty('p_user_id', 'user-456');
      expect(firstWrite.body).toHaveProperty('p_fact_key');
      expect(firstWrite.body).toHaveProperty('p_fact_value');
      expect(firstWrite.body).toHaveProperty('p_entity');
      expect(firstWrite.body).toHaveProperty('p_fact_value_type');
      expect(firstWrite.body).toHaveProperty('p_provenance_source', 'assistant_inferred');
      expect(firstWrite.body).toHaveProperty('p_provenance_confidence', 0.80);
    });

    it('should pass correct authorization headers to write_fact', async () => {
      await extractAndPersistFacts({
        conversationText: 'User: My name is Dragan and I live in Aachen.\nAssistant: Nice to meet you!',
        tenant_id: 'tenant-123',
        user_id: 'user-456',
        session_id: 'session-789',
      });

      // Find the write_fact call and check headers
      const writeFactCallArgs = mockFetch.mock.calls.find(
        (call: any[]) => call[0].includes('write_fact')
      );
      expect(writeFactCallArgs).toBeDefined();
      const headers = writeFactCallArgs![1].headers;
      expect(headers.apikey).toBe('test-service-role-key');
      expect(headers.Authorization).toBe('Bearer test-service-role-key');
    });

    it('should skip extraction for very short messages (< 30 chars)', async () => {
      await extractAndPersistFacts({
        conversationText: 'User: Hi\nAssistant: Hello',
        tenant_id: 'tenant-123',
        user_id: 'user-456',
        session_id: 'session-789',
      });

      // Should NOT have called any external services (no writes)
      const writeFactCalls = fetchCalls.filter(c => c.url.includes('write_fact'));
      expect(writeFactCalls.length).toBe(0);
    });

    it('should not throw on extraction failure (fire-and-forget safe)', async () => {
      // Make Vertex fail AND make Gemini API fail
      vertexShouldFail = true;
      mockFetch.mockImplementationOnce(async () => {
        throw new Error('Network timeout');
      });

      // Should not throw
      await expect(
        extractAndPersistFacts({
          conversationText: 'User: My name is Dragan and I live in Aachen, Germany.\nAssistant: Nice!',
          tenant_id: 'tenant-123',
          user_id: 'user-456',
          session_id: 'session-789',
        })
      ).resolves.toBeUndefined();
    });

    it('should handle write_fact RPC failure gracefully', async () => {
      // Set Vertex to return 1 fact
      vertexResponseText = '[{"fact_key":"user_name","fact_value":"Dragan","entity":"self","fact_value_type":"text"}]';

      // Override fetch to fail on write_fact
      mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
        const method = options?.method || 'GET';
        const body = options?.body ? JSON.parse(options.body as string) : undefined;
        fetchCalls.push({ url, method, body });

        if (url.includes('write_fact')) {
          return {
            ok: false,
            status: 500,
            text: async () => 'Internal server error',
          };
        }
        return { ok: true, json: async () => ({}), text: async () => '' };
      });

      // Should not throw even when write_fact fails
      await expect(
        extractAndPersistFacts({
          conversationText: 'User: My name is Dragan and I live in Aachen, Germany.\nAssistant: Nice!',
          tenant_id: 'tenant-123',
          user_id: 'user-456',
          session_id: 'session-789',
        })
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // TEST GROUP 3: write_fact RPC schema compliance
  // =========================================================================

  describe('write_fact RPC schema compliance', () => {
    it('should use correct RPC parameter names matching migration schema', async () => {
      await extractAndPersistFacts({
        conversationText: 'User: My name is Dragan Alexander and I live in Aachen.\nAssistant: Welcome!',
        tenant_id: 'test-tenant',
        user_id: 'test-user',
        session_id: 'test-session',
      });

      const writeFactCalls = fetchCalls.filter(c => c.url.includes('write_fact'));
      expect(writeFactCalls.length).toBeGreaterThanOrEqual(1);

      for (const call of writeFactCalls) {
        const body = call.body;
        // Verify ALL required parameters exist (matches write_fact() RPC signature)
        expect(body).toHaveProperty('p_tenant_id');
        expect(body).toHaveProperty('p_user_id');
        expect(body).toHaveProperty('p_fact_key');
        expect(body).toHaveProperty('p_fact_value');
        expect(body).toHaveProperty('p_entity');
        expect(body).toHaveProperty('p_fact_value_type');
        expect(body).toHaveProperty('p_provenance_source');
        expect(body).toHaveProperty('p_provenance_confidence');

        // Verify types
        expect(typeof body.p_tenant_id).toBe('string');
        expect(typeof body.p_user_id).toBe('string');
        expect(typeof body.p_fact_key).toBe('string');
        expect(typeof body.p_fact_value).toBe('string');
        expect(typeof body.p_entity).toBe('string');
        expect(typeof body.p_fact_value_type).toBe('string');
        expect(typeof body.p_provenance_source).toBe('string');
        expect(typeof body.p_provenance_confidence).toBe('number');

        // Verify provenance values
        expect(body.p_provenance_source).toBe('assistant_inferred');
        expect(body.p_provenance_confidence).toBe(0.80);
      }
    });

    it('should call correct Supabase REST endpoint for write_fact', async () => {
      await extractAndPersistFacts({
        conversationText: 'User: My name is Dragan and I live in Aachen, Germany.\nAssistant: Nice!',
        tenant_id: 'test-tenant',
        user_id: 'test-user',
        session_id: 'test-session',
      });

      const writeFactCalls = fetchCalls.filter(c => c.url.includes('write_fact'));
      for (const call of writeFactCalls) {
        expect(call.url).toBe('http://localhost:54321/rest/v1/rpc/write_fact');
        expect(call.method).toBe('POST');
      }
    });
  });
});

// =========================================================================
// TEST GROUP 4: parseFactsResponse edge cases
// Tested via extractAndPersistFacts since parseFactsResponse is not exported.
// We control the Vertex AI mock response to test different formats.
// =========================================================================

describe('VTID-01225: Fact Parsing Edge Cases', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockFetch.mockClear();
    vertexShouldFail = false;
    // Reset fetch to default
    mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const body = options?.body ? JSON.parse(options.body as string) : undefined;
      fetchCalls.push({ url, method, body });

      if (url.includes('write_fact')) {
        return { ok: true, json: async () => 'fact-id' };
      }
      return { ok: true, json: async () => ({}), text: async () => '' };
    });
  });

  it('should handle clean JSON array response', async () => {
    vertexResponseText = '[{"fact_key":"user_name","fact_value":"Dragan","entity":"self","fact_value_type":"text"}]';

    await extractAndPersistFacts({
      conversationText: 'User: My name is Dragan and I am from Aachen.\nAssistant: Welcome!',
      tenant_id: 't', user_id: 'u', session_id: 's',
    });

    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(1);
    expect(writes[0].body.p_fact_key).toBe('user_name');
    expect(writes[0].body.p_fact_value).toBe('Dragan');
  });

  it('should handle markdown-wrapped JSON response', async () => {
    vertexResponseText = '```json\n[{"fact_key":"user_name","fact_value":"Dragan","entity":"self","fact_value_type":"text"}]\n```';

    await extractAndPersistFacts({
      conversationText: 'User: My name is Dragan and I am from Aachen.\nAssistant: Welcome!',
      tenant_id: 't', user_id: 'u', session_id: 's',
    });

    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(1);
    expect(writes[0].body.p_fact_value).toBe('Dragan');
  });

  it('should handle JSON with surrounding text', async () => {
    vertexResponseText = 'Here are the extracted facts:\n[{"fact_key":"user_name","fact_value":"Dragan","entity":"self","fact_value_type":"text"}]\nThese are all the facts found.';

    await extractAndPersistFacts({
      conversationText: 'User: My name is Dragan and I am from Aachen.\nAssistant: Welcome!',
      tenant_id: 't', user_id: 'u', session_id: 's',
    });

    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(1);
  });

  it('should handle empty array response (no facts)', async () => {
    vertexResponseText = '[]';

    await extractAndPersistFacts({
      conversationText: 'User: Hello how are you today?\nAssistant: I am doing great!',
      tenant_id: 't', user_id: 'u', session_id: 's',
    });

    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(0);
  });

  it('should handle completely malformed response', async () => {
    vertexResponseText = 'I could not extract any facts from this conversation.';

    await extractAndPersistFacts({
      conversationText: 'User: Hello how are you today my friend?\nAssistant: I am doing great!',
      tenant_id: 't', user_id: 'u', session_id: 's',
    });

    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(0);
  });

  it('should filter out facts with missing required fields', async () => {
    vertexResponseText = JSON.stringify([
      { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text' },  // valid
      { fact_key: '', fact_value: 'bad', entity: 'self', fact_value_type: 'text' },              // empty key
      { fact_key: 'test', fact_value: '', entity: 'self', fact_value_type: 'text' },             // empty value
      { fact_key: 'test2', fact_value: 'val', entity: 'self' },                                  // missing fact_value_type
    ]);

    await extractAndPersistFacts({
      conversationText: 'User: My name is Dragan and I am from Aachen.\nAssistant: Welcome!',
      tenant_id: 't', user_id: 'u', session_id: 's',
    });

    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(1); // Only the valid one
    expect(writes[0].body.p_fact_key).toBe('user_name');
  });

  it('should handle multiple facts in a single extraction', async () => {
    vertexResponseText = JSON.stringify([
      { fact_key: 'user_name', fact_value: 'Dragan Alexander', entity: 'self', fact_value_type: 'text' },
      { fact_key: 'user_residence', fact_value: 'Aachen', entity: 'self', fact_value_type: 'text' },
      { fact_key: 'fiancee_name', fact_value: 'Mariia Maksina', entity: 'disclosed', fact_value_type: 'text' },
      { fact_key: 'user_favorite_tea', fact_value: 'Earl Grey', entity: 'self', fact_value_type: 'text' },
    ]);

    await extractAndPersistFacts({
      conversationText: 'User: I am Dragan Alexander, I live in Aachen with my fiancée Mariia Maksina. I love Earl Grey tea.\nAssistant: That sounds lovely!',
      tenant_id: 'tenant-real', user_id: 'user-real', session_id: 'session-real',
    });

    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(4);

    // Verify each fact was persisted with correct tenant/user
    for (const write of writes) {
      expect(write.body.p_tenant_id).toBe('tenant-real');
      expect(write.body.p_user_id).toBe('user-real');
    }

    // Verify specific facts
    const factKeys = writes.map(w => w.body.p_fact_key);
    expect(factKeys).toContain('user_name');
    expect(factKeys).toContain('user_residence');
    expect(factKeys).toContain('fiancee_name');
    expect(factKeys).toContain('user_favorite_tea');
  });

  it('should handle Vertex failure and fall through to Gemini API', async () => {
    vertexShouldFail = true;

    // Gemini API fallback should return facts
    mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const body = options?.body ? JSON.parse(options.body as string) : undefined;
      fetchCalls.push({ url, method, body });

      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: '[{"fact_key":"user_name","fact_value":"Dragan","entity":"self","fact_value_type":"text"}]',
                }],
              },
            }],
          }),
        };
      }

      if (url.includes('write_fact')) {
        return { ok: true, json: async () => 'fact-id' };
      }

      return { ok: true, json: async () => ({}), text: async () => '' };
    });

    await extractAndPersistFacts({
      conversationText: 'User: My name is Dragan and I am from Aachen.\nAssistant: Welcome!',
      tenant_id: 't', user_id: 'u', session_id: 's',
    });

    // Should have called Gemini API as fallback
    const geminiCalls = fetchCalls.filter(c => c.url.includes('generativelanguage.googleapis.com'));
    expect(geminiCalls.length).toBe(1);

    // Should still persist the fact
    const writes = fetchCalls.filter(c => c.url.includes('write_fact'));
    expect(writes.length).toBe(1);
    expect(writes[0].body.p_fact_key).toBe('user_name');
  });
});

// =========================================================================
// TEST GROUP 5: Context Pack Builder reads inline-extracted facts
// =========================================================================

describe('VTID-01225: Context Pack reads inline-extracted facts', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockFetch.mockClear();

    // Restore default mock that returns facts from memory_facts
    mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      fetchCalls.push({ url, method });

      if (url.includes('/rest/v1/memory_facts') && method === 'GET') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'fact-1',
              fact_key: 'user_name',
              fact_value: 'Dragan Alexander',
              entity: 'self',
              provenance_confidence: 0.80,
              provenance_source: 'assistant_inferred',  // This is what inline extractor writes
            },
            {
              id: 'fact-2',
              fact_key: 'user_residence',
              fact_value: 'Aachen',
              entity: 'self',
              provenance_confidence: 0.80,
              provenance_source: 'assistant_inferred',
            },
          ],
        };
      }

      if (url.includes('/rest/v1/memory_items') && method === 'GET') {
        return { ok: true, json: async () => [] };
      }

      if (url.includes('/rest/v1/relationship_nodes') && method === 'GET') {
        return { ok: true, json: async () => [] };
      }

      if (url.includes('/rest/v1/relationship_edges') && method === 'GET') {
        return { ok: true, json: async () => [] };
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
            choices: [{ message: { content: 'Web result' } }],
            citations: [],
          }),
        };
      }

      return { ok: true, json: async () => ({}), text: async () => '' };
    });
  });

  // Mock knowledge hub
  jest.mock('../src/services/knowledge-hub', () => ({
    searchKnowledge: jest.fn().mockResolvedValue({ ok: true, docs: [] }),
  }));

  // Mock OASIS events
  jest.mock('../src/services/oasis-event-service', () => ({
    emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
  }));

  it('should read facts written by inline extractor (provenance_source=assistant_inferred)', async () => {
    const { buildContextPack, formatContextPackForLLM } = await import('../src/services/context-pack-builder');
    const { createContextLens } = await import('../src/types/context-lens');
    const { computeRetrievalRouterDecision } = await import('../src/services/retrieval-router');

    const lens = createContextLens('test-tenant', 'test-user', {
      workspace_scope: 'product',
      active_role: 'community',
    });

    const routerDecision = computeRetrievalRouterDecision("What's my name?", { channel: 'orb' });

    const pack = await buildContextPack({
      lens,
      query: "What's my name?",
      channel: 'orb',
      thread_id: 'test-thread',
      turn_number: 1,
      conversation_start: new Date().toISOString(),
      role: 'community',
      router_decision: routerDecision,
    });

    // Verify memory_facts was queried
    const factsQueries = fetchCalls.filter(c => c.url.includes('memory_facts') && c.method === 'GET');
    expect(factsQueries.length).toBeGreaterThanOrEqual(1);

    // Verify the query filters correctly (superseded_by=is.null)
    expect(factsQueries[0].url).toContain('superseded_by=is.null');

    // Verify the query uses provenance_confidence (not confidence)
    expect(factsQueries[0].url).toContain('provenance_confidence');

    // Verify facts appear in LLM context
    const llmContext = formatContextPackForLLM(pack);
    expect(llmContext).toContain('user_name: Dragan Alexander');
    expect(llmContext).toContain('user_residence: Aachen');
    expect(llmContext).toContain('<structured_facts>');
  });

  it('should include inline-extracted facts in memory_hits with correct category', async () => {
    const { buildContextPack } = await import('../src/services/context-pack-builder');
    const { createContextLens } = await import('../src/types/context-lens');
    const { computeRetrievalRouterDecision } = await import('../src/services/retrieval-router');

    const lens = createContextLens('test-tenant', 'test-user', {
      workspace_scope: 'product',
      active_role: 'community',
    });

    const routerDecision = computeRetrievalRouterDecision("What's my name?", { channel: 'orb' });

    const pack = await buildContextPack({
      lens,
      query: "What's my name?",
      channel: 'orb',
      thread_id: 'test-thread',
      turn_number: 1,
      conversation_start: new Date().toISOString(),
      role: 'community',
      router_decision: routerDecision,
    });

    // Facts should be in memory_hits with fact: prefix on category
    const factHits = pack.memory_hits.filter(h => h.category_key.startsWith('fact:'));
    expect(factHits.length).toBe(2);

    // Content should be formatted as "fact_key: fact_value"
    const contents = factHits.map(h => h.content);
    expect(contents).toContain('user_name: Dragan Alexander');
    expect(contents).toContain('user_residence: Aachen');
  });
});
