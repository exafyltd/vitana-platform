/**
 * Inline Fact Extractor — DeepSeek primary provider
 * (BOOTSTRAP-MEMORY-DAILY-LEARNING)
 *
 * DeepSeek was made the PRIMARY extraction provider after Vertex calls
 * were found failing at runtime on gateway-staging (env reports Vertex
 * "configured" but the actual call returned nothing for every tested
 * conversation). This is a separate test file (not added to
 * inline-fact-extractor.test.ts) because DEEPSEEK_API_KEY must be set
 * BEFORE the module is imported — top-level module consts read env vars
 * once at import time, and the existing suite deliberately leaves
 * DEEPSEEK_API_KEY unset to test the pre-DeepSeek fallback chain.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';

const fetchCalls: Array<{ url: string; method: string; body?: any }> = [];
let deepseekResponseText = JSON.stringify([
  { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text', stated: true },
]);
let deepseekShouldFail = false;

jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockImplementation(async () => ({
        response: {
          candidates: [{ content: { parts: [{ text: '[]' }] } }],
        },
      })),
    }),
  })),
}));

const mockFetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => {
  const method = options?.method || 'GET';
  const body = options?.body ? JSON.parse(options.body as string) : undefined;
  fetchCalls.push({ url, method, body });

  if (url.includes('api.deepseek.com')) {
    if (deepseekShouldFail) {
      return { ok: false, status: 500, text: async () => 'DeepSeek down' };
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: deepseekResponseText } }] }),
    };
  }
  if (url.includes('/rest/v1/rpc/write_fact')) {
    return { ok: true, json: async () => 'fact-uuid-ds' };
  }
  if (url.includes('/rest/v1/memory_facts?')) {
    return { ok: true, json: async () => [] };
  }
  if (url.includes('check_canonical_fact_key')) {
    return { ok: true, json: async () => ({ ok: true, mapped: false }) };
  }
  return { ok: true, json: async () => ({}), text: async () => '' };
});
global.fetch = mockFetch as any;

import { extractAndPersistFacts } from '../src/services/inline-fact-extractor';

describe('inline-fact-extractor: DeepSeek as primary provider', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockFetch.mockClear();
    deepseekShouldFail = false;
    deepseekResponseText = JSON.stringify([
      { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text', stated: true },
    ]);
  });

  it('calls DeepSeek chat completions first and persists the extracted fact', async () => {
    await extractAndPersistFacts({
      conversationText: 'User: My name is Dragan and I live in Aachen.\nAssistant: Nice to meet you!',
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      session_id: 'session-789',
    });

    const dsCall = fetchCalls.find((c) => c.url.includes('api.deepseek.com'));
    expect(dsCall).toBeDefined();
    expect(dsCall!.method).toBe('POST');
    expect(dsCall!.body.model).toBe('deepseek-chat');
    expect(dsCall!.body.messages[0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(dsCall!.body.messages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Dragan'),
    });

    const writeFactCall = fetchCalls.find((c) => c.url.includes('rpc/write_fact'));
    expect(writeFactCall).toBeDefined();
    expect(writeFactCall!.body.p_fact_value).toBe('Dragan');
    expect(writeFactCall!.body.p_provenance_source).toBe('user_stated');
  });

  it('falls through to Vertex when DeepSeek errors', async () => {
    deepseekShouldFail = true;
    await extractAndPersistFacts({
      conversationText: 'User: My name is Dragan and I live in Aachen.\nAssistant: Nice to meet you!',
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      session_id: 'session-789',
    });
    const dsCall = fetchCalls.find((c) => c.url.includes('api.deepseek.com'));
    expect(dsCall).toBeDefined();
    // Vertex mock (above) returns '[]' → 0 facts → no write_fact call, but no throw either.
    const writeFactCall = fetchCalls.find((c) => c.url.includes('rpc/write_fact'));
    expect(writeFactCall).toBeUndefined();
  });

  it('falls through to Vertex when DeepSeek returns 0 parseable facts', async () => {
    deepseekResponseText = '[]';
    await extractAndPersistFacts({
      conversationText: 'User: Just saying hello, nothing specific.\nAssistant: Hi there!',
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      session_id: 'session-789',
    });
    const dsCall = fetchCalls.find((c) => c.url.includes('api.deepseek.com'));
    expect(dsCall).toBeDefined();
  });
});
