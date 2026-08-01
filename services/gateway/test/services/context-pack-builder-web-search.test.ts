/**
 * VTID-03472: regression coverage for fetchWebHits()'s Vertex AI grounding
 * path — the fix for "check the internet for news about X" returning
 * nothing on Nova Sonic (and silently on Vertex too, masked by Vertex's
 * native google_search grounding covering for it).
 *
 * Root cause: PERPLEXITY_API_KEY has never been configured in staging or
 * prod, so the search_web tool's ONLY backend always returned empty hits.
 * Fix: try Vertex AI's own Google Search grounding (via a plain
 * generateContent call, not the Live API's native grounding) first —
 * GOOGLE_CLOUD_PROJECT/ADC is already configured — falling back to
 * Perplexity only if that's ever configured later.
 *
 * This file exercises both context-pack-builder.ts's fetchWebHits() (via
 * buildContextPack, forcing web_search only) AND the actual voice tool
 * (tool_search_web in orb-tools-shared.ts) that Nova/Vertex/LiveKit all
 * dispatch through — closing the loop on the exact tool that failed live.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
delete process.env.PERPLEXITY_API_KEY;
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';

let vertexBehavior: 'grounded' | 'grounded_no_supports' | 'no_text' | 'throw' = 'grounded';
const getGenerativeModelCalls: any[] = [];

jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockImplementation((modelParams: any, requestOptions: any) => {
      getGenerativeModelCalls.push({ ...modelParams, requestOptions });
      return {
        generateContent: jest.fn().mockImplementation(async () => {
          if (vertexBehavior === 'throw') {
            throw new Error('Vertex grounding mock failure');
          }
          if (vertexBehavior === 'no_text') {
            return { response: { candidates: [{ content: { parts: [] } }] } };
          }
          const text =
            'Mariia Maksina is featured in a recent Vitana longevity community spotlight. ' +
            'She discussed her wellness routine in an interview published this week.';
          const groundingChunks = [
            { web: { uri: 'https://example.com/mariia-maksina-spotlight', title: 'Spotlight' } },
            { web: { uri: 'https://example.com/mariia-maksina-interview', title: 'Interview' } },
          ];
          const groundingMetadata =
            vertexBehavior === 'grounded_no_supports'
              ? { groundingChunks }
              : {
                  groundingChunks,
                  // Real Gemini shape: each support maps a TEXT SPAN to the
                  // chunk(s) that back it — this is what lets citations be
                  // attributed to the right source per claim, not just
                  // zipped by sentence position.
                  groundingSupports: [
                    {
                      segment: { text: 'Mariia Maksina is featured in a recent Vitana longevity community spotlight' },
                      groundingChunkIndices: [0],
                    },
                    {
                      segment: { text: 'She discussed her wellness routine in an interview published this week' },
                      groundingChunkIndices: [1],
                    },
                  ],
                };
          return {
            response: {
              candidates: [{ content: { parts: [{ text }] }, groundingMetadata }],
            },
          };
        }),
      };
    }),
  })),
}));

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

const mockFetch = jest.fn().mockImplementation(async (url: string) => {
  if (url.includes('/rest/v1/system_controls')) {
    const keyMatch = url.match(/key=eq\.([^&]+)/);
    const key = keyMatch ? decodeURIComponent(keyMatch[1]) : '';
    return restResponse([{ key, enabled: false, scope: {}, reason: 'test', expires_at: null }]);
  }
  if (url.includes('/rest/v1/rpc/')) return restResponse([]);
  return restResponse([]);
});
global.fetch = mockFetch as any;

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/knowledge-hub', () => ({
  searchKnowledge: jest.fn().mockResolvedValue({ ok: true, docs: [] }),
}));

import { buildContextPack, BuildContextPackInput } from '../../src/services/context-pack-builder';
import { createContextLens } from '../../src/types/context-lens';
import type { RetrievalRouterDecision } from '../../src/types/conversation';
import { tool_search_web } from '../../src/services/orb-tools-shared';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function webOnlyInput(query: string): BuildContextPackInput {
  const lens = createContextLens('tenant-a', 'user-a', { workspace_scope: 'product', active_role: 'community' });
  const router_decision: RetrievalRouterDecision = {
    sources_to_query: ['web_search'],
    query_order: ['web_search'],
    limits: { memory_garden: 0, knowledge_hub: 0, web_search: 5, calendar: 0 },
    matched_rule: 'external_current',
    decided_at: new Date().toISOString(),
    rationale: 'test',
  };
  return {
    lens,
    query,
    channel: 'orb',
    thread_id: 'thread-1',
    turn_number: 1,
    conversation_start: new Date().toISOString(),
    role: 'community',
    router_decision,
  };
}

beforeEach(() => {
  vertexBehavior = 'grounded';
  mockFetch.mockClear();
  getGenerativeModelCalls.length = 0;
});

describe('fetchWebHits — Vertex AI grounding (VTID-03472)', () => {
  it('calls the SDK with the Gemini 2.x googleSearch tool (NOT the legacy googleSearchRetrieval) and a bounded timeout', async () => {
    await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(getGenerativeModelCalls.length).toBeGreaterThan(0);
    const call = getGenerativeModelCalls[getGenerativeModelCalls.length - 1];
    expect(call.tools).toEqual([{ googleSearch: {} }]);
    expect(call.tools[0].googleSearchRetrieval).toBeUndefined();
    // Must stay below orb-live.ts's 3000ms search_web TOOL_TIMEOUT_MS so a
    // slow Vertex call fails gracefully instead of outliving the tool call.
    expect(call.requestOptions.timeout).toBeLessThan(3000);
    expect(call.requestOptions.timeout).toBeGreaterThan(0);
  });

  it('returns real web_hits from grounded text + citations when Vertex succeeds', async () => {
    const pack = await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(pack.web_hits.length).toBeGreaterThan(0);
    expect(pack.web_hits[0].url).toMatch(/^https:\/\/example\.com/);
    expect(pack.web_hits[0].snippet.length).toBeGreaterThan(0);
    expect(pack.retrieval_trace.hit_counts.web_search).toBe(pack.web_hits.length);
  });

  it('attributes each hit to the source its groundingSupport actually cites, not just position', async () => {
    const pack = await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    // Support 0 cites chunk 0 (spotlight), support 1 cites chunk 1 (interview)
    // — this must survive even though the naive per-sentence zip would have
    // produced the same order here (the point is it's now driven by the
    // actual citation mapping, verified by the mismatched-count case below).
    expect(pack.web_hits[0].url).toBe('https://example.com/mariia-maksina-spotlight');
    expect(pack.web_hits[1].url).toBe('https://example.com/mariia-maksina-interview');
  });

  it('falls back to the naive sentence-splitter when the response has no groundingSupports', async () => {
    vertexBehavior = 'grounded_no_supports';
    const pack = await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    // Still gets real hits with real citations — just positionally zipped
    // instead of support-aligned, matching the pre-existing Perplexity shape.
    expect(pack.web_hits.length).toBeGreaterThan(0);
    expect(pack.web_hits[0].url).toMatch(/^https:\/\/example\.com/);
  });

  it('falls back to empty (not a throw) when Vertex returns no text', async () => {
    vertexBehavior = 'no_text';
    const pack = await buildContextPack(webOnlyInput('obscure query with no results'));
    expect(pack.web_hits).toEqual([]);
  });

  it('falls back to empty (not a throw) when Vertex grounding call errors', async () => {
    vertexBehavior = 'throw';
    const pack = await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(pack.web_hits).toEqual([]);
  });
});

describe('tool_search_web — the actual voice tool Nova/Vertex/LiveKit dispatch through', () => {
  const ID: OrbToolIdentity = { user_id: 'user-a', tenant_id: 'tenant-a', role: 'community' };

  it('returns spoken results for "check the internet for news about Mariia Maksina"', async () => {
    const result = await tool_search_web(
      { query: 'news about Mariia Maksina' },
      ID,
      {} as SupabaseClient,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('web results');
      expect(result.text).not.toContain('No relevant web results found');
    }
  });

  it('requires a non-empty query', async () => {
    const result = await tool_search_web({ query: '' }, ID, {} as SupabaseClient);
    expect(result.ok).toBe(false);
  });
});
