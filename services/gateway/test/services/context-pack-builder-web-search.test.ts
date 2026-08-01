/**
 * VTID-03472: regression coverage for fetchWebHits()'s Claude web_search
 * path — the fix for "check the internet for news about X" returning
 * nothing on Nova Sonic (and silently on Vertex too, masked by Vertex's
 * native google_search grounding covering for it).
 *
 * Root cause: PERPLEXITY_API_KEY has never been configured in staging or
 * prod, so the search_web tool's ONLY backend always returned empty hits.
 *
 * Fix (v2 — Vertex REMOVED): use Claude's native web_search server-side tool
 * via the direct Anthropic API (ANTHROPIC_API_KEY), not Vertex/GCP. ORB voice
 * moved off Vertex to Nova Sonic 5 days before this fix, and GCP itself is
 * being decommissioned entirely (2026-08-03) — a Vertex dependency here
 * would have silently regressed within days. Bedrock does NOT relay to
 * Anthropic's hosted search endpoint, so this must be the direct API, not
 * Bedrock credentials.
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
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

let claudeBehavior: 'cited' | 'no_citations' | 'throw' = 'cited';
const messagesCreateCalls: any[] = [];

jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn().mockImplementation(async (body: any, requestOptions: any) => {
          messagesCreateCalls.push({ ...body, requestOptions });
          if (claudeBehavior === 'throw') {
            throw new Error('Claude web_search mock failure');
          }
          if (claudeBehavior === 'no_citations') {
            return { content: [{ type: 'text', text: 'No results found.', citations: null }] };
          }
          return {
            content: [
              {
                type: 'server_tool_use',
                id: 'srvtool_1',
                name: 'web_search',
                input: { query: 'Mariia Maksina news' },
              },
              {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtool_1',
                content: [
                  { type: 'web_search_result', title: 'Spotlight', url: 'https://example.com/mariia-maksina-spotlight', encrypted_content: 'x', page_age: null },
                  { type: 'web_search_result', title: 'Interview', url: 'https://example.com/mariia-maksina-interview', encrypted_content: 'x', page_age: null },
                ],
              },
              {
                type: 'text',
                text: 'Mariia Maksina is featured in a recent Vitana longevity community spotlight. She discussed her wellness routine in an interview published this week.',
                citations: [
                  {
                    type: 'web_search_result_location',
                    cited_text: 'Mariia Maksina is featured in a recent Vitana longevity community spotlight',
                    title: 'Spotlight',
                    url: 'https://example.com/mariia-maksina-spotlight',
                    encrypted_index: 'x',
                  },
                  {
                    type: 'web_search_result_location',
                    cited_text: 'She discussed her wellness routine in an interview published this week',
                    title: 'Interview',
                    url: 'https://example.com/mariia-maksina-interview',
                    encrypted_index: 'x',
                  },
                ],
              },
            ],
          };
        }),
      },
    })),
  };
});

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
  claudeBehavior = 'cited';
  mockFetch.mockClear();
  messagesCreateCalls.length = 0;
});

describe('fetchWebHits — Claude web_search (VTID-03472)', () => {
  it('calls the Anthropic SDK with the web_search tool and a bounded timeout — never Vertex/GCP', async () => {
    await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(messagesCreateCalls.length).toBeGreaterThan(0);
    const call = messagesCreateCalls[messagesCreateCalls.length - 1];
    expect(call.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    // Must stay below orb-live.ts's 3000ms search_web TOOL_TIMEOUT_MS so a
    // slow call fails gracefully instead of outliving the tool call.
    expect(call.requestOptions.timeout).toBeLessThan(3000);
    expect(call.requestOptions.timeout).toBeGreaterThan(0);
    // VTID-03472 follow-up: verified live on staging that without an
    // explicit instruction, Claude (esp. Haiku) sometimes answers directly
    // and skips invoking web_search entirely, returning zero hits for a
    // clearly time-sensitive query. This call exists ONLY to search, so it
    // must not leave that judgment call to the model.
    expect(call.system).toEqual(expect.stringContaining('MUST invoke the web_search tool'));
  });

  it('returns real web_hits from Claude web_search citations', async () => {
    const pack = await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(pack.web_hits.length).toBe(2);
    expect(pack.web_hits[0].url).toBe('https://example.com/mariia-maksina-spotlight');
    expect(pack.web_hits[1].url).toBe('https://example.com/mariia-maksina-interview');
    expect(pack.web_hits[0].snippet).toContain('Mariia Maksina');
    expect(pack.retrieval_trace.hit_counts.web_search).toBe(pack.web_hits.length);
  });

  it('falls back to empty (not a throw) when Claude returns no citations', async () => {
    claudeBehavior = 'no_citations';
    const pack = await buildContextPack(webOnlyInput('obscure query with no results'));
    expect(pack.web_hits).toEqual([]);
  });

  it('falls back to empty (not a throw) when the Claude call errors', async () => {
    claudeBehavior = 'throw';
    const pack = await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(pack.web_hits).toEqual([]);
  });

  it('never imports @google-cloud/vertexai — Vertex/GCP is fully removed', async () => {
    await buildContextPack(webOnlyInput('news about Mariia Maksina'));
    expect(require.cache[require.resolve('@google-cloud/vertexai')]).toBeUndefined();
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
