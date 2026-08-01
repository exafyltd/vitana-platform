/**
 * VTID-03462: regression coverage for fetchWebHits()'s Vertex AI grounding
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

let vertexBehavior: 'grounded' | 'no_text' | 'throw' = 'grounded';

jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockImplementation(async () => {
        if (vertexBehavior === 'throw') {
          throw new Error('Vertex grounding mock failure');
        }
        if (vertexBehavior === 'no_text') {
          return { response: { candidates: [{ content: { parts: [] } }] } };
        }
        return {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text:
                        'Mariia Maksina is featured in a recent Vitana longevity community spotlight. ' +
                        'She discussed her wellness routine in an interview published this week. ' +
                        'The community praised her insights on healthy aging practices.',
                    },
                  ],
                },
                groundingMetadata: {
                  groundingChunks: [
                    { web: { uri: 'https://example.com/mariia-maksina-spotlight', title: 'Spotlight' } },
                    { web: { uri: 'https://example.com/mariia-maksina-interview', title: 'Interview' } },
                  ],
                },
              },
            ],
          },
        };
      }),
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
});

describe('fetchWebHits — Vertex AI grounding (VTID-03462)', () => {
  it('returns real web_hits from grounded text + citations when Vertex succeeds', async () => {
    const pack = await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(pack.web_hits.length).toBeGreaterThan(0);
    expect(pack.web_hits[0].url).toMatch(/^https:\/\/example\.com/);
    expect(pack.web_hits[0].snippet.length).toBeGreaterThan(0);
    expect(pack.retrieval_trace.hit_counts.web_search).toBe(pack.web_hits.length);
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
