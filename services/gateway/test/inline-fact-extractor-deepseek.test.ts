/**
 * Inline Fact Extractor — routing, not a hardcoded provider (VTID-03579)
 *
 * This file used to pin "DeepSeek is the PRIMARY extraction provider, Vertex is
 * the fallback" (BOOTSTRAP-MEMORY-DAILY-LEARNING). That cascade is gone: naming
 * three providers inside this module meant `llm_routing_policy` could say the
 * platform was off Google while this path went on billing it — which is exactly
 * how the Gemini API line stayed invisible for months.
 *
 * The tests below therefore guard the invariant that REPLACED it, and it is the
 * stronger one: the extractor asks the router and never speaks to a provider
 * itself. A test that asserted "Bedrock was called" would just be the same
 * hardcoding one provider further along — it would fail the next time routing
 * legitimately changes, and it would still not catch someone re-adding a direct
 * fetch to api.deepseek.com. Asserting the ABSENCE of direct provider calls is
 * what actually holds.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';
// Deliberately set: these are the credentials the old cascade keyed off. If a
// direct provider call is ever reintroduced it will find working-looking creds
// and fire, so the "no direct provider call" assertions below stay meaningful.
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';

const fetchCalls: Array<{ url: string; method: string; body?: any }> = [];

let routerResponse: { ok: boolean; text?: string; error?: string; provider?: string; model?: string } = {
  ok: true,
  provider: 'bedrock',
  model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  text: JSON.stringify([
    { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text', stated: true },
  ]),
};

const callViaRouter = jest.fn(async () => routerResponse);
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: (...args: unknown[]) => callViaRouter(...(args as [])),
}));

const mockFetch = jest.fn().mockImplementation(async (url: string, options?: RequestInit) => {
  const method = options?.method || 'GET';
  const body = options?.body ? JSON.parse(options.body as string) : undefined;
  fetchCalls.push({ url, method, body });

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

const CONVERSATION =
  'User: My name is Dragan and I live in Aachen.\nAssistant: Nice to meet you!';

describe('inline-fact-extractor: provider comes from routing (VTID-03579)', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockFetch.mockClear();
    callViaRouter.mockClear();
    routerResponse = {
      ok: true,
      provider: 'bedrock',
      model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      text: JSON.stringify([
        { fact_key: 'user_name', fact_value: 'Dragan', entity: 'self', fact_value_type: 'text', stated: true },
      ]),
    };
  });

  it('extracts via the router and persists the fact', async () => {
    await extractAndPersistFacts({
      conversationText: CONVERSATION,
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      session_id: 'session-789',
    });

    expect(callViaRouter).toHaveBeenCalledTimes(1);
    const [stage, prompt, opts] = callViaRouter.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(stage).toBe('memory');
    expect(prompt).toContain('Dragan');
    expect(opts.service).toBe('inline-fact-extractor');
    // The extraction contract lives in the system prompt, not the user turn —
    // if it ever moves into the prompt the model starts echoing instructions.
    expect(String(opts.systemPrompt)).toContain('fact_key');

    const writeFactCall = fetchCalls.find((c) => c.url.includes('rpc/write_fact'));
    expect(writeFactCall).toBeDefined();
    expect(writeFactCall!.body.p_fact_value).toBe('Dragan');
    expect(writeFactCall!.body.p_provenance_source).toBe('user_stated');
  });

  it('never calls a generation provider directly — no DeepSeek, Vertex or Gemini fetch', async () => {
    await extractAndPersistFacts({
      conversationText: CONVERSATION,
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      session_id: 'session-789',
    });

    const providerHosts = [
      'api.deepseek.com',
      'generativelanguage.googleapis.com',
      'aiplatform.googleapis.com',
      'api.anthropic.com',
      'bedrock-runtime',
    ];
    const direct = fetchCalls
      // VTID-04342: embeddings moved to Bedrock Titan V2 (SDK, not fetch), so
      // the old `:embedContent` carve-out is gone and ANY Google call fails.
      .filter((c) => providerHosts.some((h) => c.url.includes(h)));
    expect(direct).toEqual([]);
  });

  it('fails soft when the router cannot serve — no throw, no write', async () => {
    routerResponse = { ok: false, error: 'no provider available', provider: 'bedrock' };

    await expect(
      extractAndPersistFacts({
        conversationText: CONVERSATION,
        tenant_id: 'tenant-123',
        user_id: 'user-456',
        session_id: 'session-789',
      }),
    ).resolves.not.toThrow();

    // Extraction is best-effort enrichment layered onto the user's real
    // request: a provider outage must degrade memory, never the conversation.
    const writeFactCall = fetchCalls.find((c) => c.url.includes('rpc/write_fact'));
    expect(writeFactCall).toBeUndefined();
  });

  it('writes nothing when the model returns an empty fact array', async () => {
    routerResponse = { ok: true, provider: 'bedrock', model: 'haiku', text: '[]' };

    await extractAndPersistFacts({
      conversationText: 'User: Just saying hello, nothing specific.\nAssistant: Hi there!',
      tenant_id: 'tenant-123',
      user_id: 'user-456',
      session_id: 'session-789',
    });

    expect(callViaRouter).toHaveBeenCalledTimes(1);
    const writeFactCall = fetchCalls.find((c) => c.url.includes('rpc/write_fact'));
    expect(writeFactCall).toBeUndefined();
  });
});
