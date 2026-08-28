/**
 * embedding-service.ts fallback ORDER (VTID-GATEWAY-GOOGLE-DEPENDENCY-AUDIT).
 *
 * Closes GATEWAY-GOOGLE-DEPENDENCY-AUDIT-2026-08-28 finding #1/#2:
 * embedding-service.ts fell back to Gemini unconditionally on any OpenAI
 * failure. This pins the new order — OpenAI -> Titan/Bedrock -> Gemini
 * (last resort only) — and that a successful Google fallback is now logged
 * as a policy-violation incident (status 'error', not 'warning'), per
 * CLAUDE.md NEVER-27 / IF-THEN-29 ("a fallback that lands on Google must be
 * treated as an incident, not as normal operation").
 *
 * Titan itself is mocked at the provider-module boundary (not the AWS SDK)
 * — titan-embedding.test.ts already covers the not_configured gate and the
 * dimension contract directly; this file only needs to prove
 * embedding-service.ts calls things in the right order and reacts correctly
 * to each outcome.
 */

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';

const emitted: Array<{ type: string; status?: string; payload: Record<string, unknown>; message?: string }> = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: any) => {
    emitted.push(e);
    return undefined;
  }),
}));

jest.mock('../src/services/embedding-cache', () => ({
  getCachedEmbedding: jest.fn(() => null),
  setCachedEmbedding: jest.fn(),
  getCacheStats: jest.fn(() => ({ hits: 0, misses: 0, size: 0 })),
}));

let titanOutcome: 'ok' | 'fail' = 'ok';
const mockGenerateTitanEmbedding = jest.fn(async () => {
  if (titanOutcome === 'ok') {
    return {
      ok: true as const,
      embedding: Array.from({ length: 1536 }, () => 0.5),
      model: 'amazon.titan-embed-text-v1',
      dimensions: 1536,
      latency_ms: 42,
    };
  }
  return {
    ok: false as const,
    error: 'not_configured' as const,
    message: 'BEDROCK_ROLE_ARN not set; Titan embeddings dormant',
  };
});
jest.mock('../src/providers/titan-embedding', () => ({
  generateTitanEmbedding: (...args: unknown[]) => mockGenerateTitanEmbedding(...(args as [string])),
  getTitanEmbeddingModelId: () => 'amazon.titan-embed-text-v1',
  TITAN_EMBEDDING_DIMENSIONS: 1536,
}));

let openaiOk = true;
const vec = (n: number) => Array.from({ length: 1536 }, () => n);
const mockFetch = jest.fn(async (url: string) => {
  const u = String(url);
  if (u.includes('api.openai.com')) {
    if (!openaiOk) return { ok: false, status: 500, text: async () => 'openai down' } as any;
    return {
      ok: true,
      json: async () => ({ data: [{ embedding: vec(0.1) }], model: 'text-embedding-3-small' }),
    } as any;
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    return { ok: true, json: async () => ({ embedding: { values: vec(0.9) } }) } as any;
  }
  return { ok: true, json: async () => ({}), text: async () => '' } as any;
});
global.fetch = mockFetch as unknown as typeof fetch;

import { generateEmbedding, generateBatchEmbeddings } from '../src/services/embedding-service';

describe('embedding-service fallback order: OpenAI -> Titan/Bedrock -> Gemini (last resort)', () => {
  beforeEach(() => {
    emitted.length = 0;
    mockFetch.mockClear();
    mockGenerateTitanEmbedding.mockClear();
    openaiOk = false; // every test here exercises the fallback path
    titanOutcome = 'ok';
  });

  it('uses Titan when OpenAI fails, and never calls Gemini', async () => {
    const r = await generateEmbedding('alpha');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model).toBe('amazon.titan-embed-text-v1');
      expect(r.dimensions).toBe(1536);
    }

    expect(mockGenerateTitanEmbedding).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('generativelanguage.googleapis.com'), expect.anything());

    const ev = emitted.find((e) => e.type === 'embedding.fallback_used');
    expect(ev).toBeDefined();
    expect(ev!.payload.provider).toBe('titan_bedrock');
    expect(ev!.status).toBe('warning'); // sanctioned AWS-native fallback, not an incident
  });

  it('falls through to Gemini only when Titan ALSO fails, and logs it as an incident', async () => {
    titanOutcome = 'fail';

    const r = await generateEmbedding('alpha');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model).toBeTruthy();

    expect(mockGenerateTitanEmbedding).toHaveBeenCalledTimes(1);

    const ev = emitted.find((e) => e.type === 'embedding.google_fallback_used');
    expect(ev).toBeDefined();
    // Incident, not routine — this is the whole point of the reorder.
    expect(ev!.status).toBe('error');
    expect(ev!.payload.policy_violation).toBe(true);
    expect(ev!.payload.provider).toBe('gemini');
    expect(ev!.payload.titan_error).toContain('not_configured');

    // The old event type must not fire any more for this path — a dashboard
    // or alert still filtering on 'embedding.fallback_used' at 'warning'
    // would otherwise silently miss every Google incident.
    const oldStyleEvent = emitted.find(
      (e) => e.type === 'embedding.fallback_used' && e.payload.provider === 'gemini',
    );
    expect(oldStyleEvent).toBeUndefined();
  });

  it('reports all three providers failed when OpenAI, Titan and Gemini all fail', async () => {
    titanOutcome = 'fail';
    global.fetch = jest.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('generativelanguage.googleapis.com')) {
        return { ok: false, status: 500, text: async () => 'gemini down' } as any;
      }
      return { ok: false, status: 500, text: async () => 'openai down' } as any;
    }) as unknown as typeof fetch;

    const r = await generateEmbedding('alpha');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('OpenAI');
      expect(r.error).toContain('Titan');
      expect(r.error).toContain('Gemini');
    }
  });
});

describe('generateBatchEmbeddings fallback order', () => {
  beforeEach(() => {
    emitted.length = 0;
    mockGenerateTitanEmbedding.mockClear();
    titanOutcome = 'ok';
    global.fetch = jest.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('api.openai.com')) return { ok: false, status: 500, text: async () => 'openai down' } as any;
      if (u.includes('generativelanguage.googleapis.com')) {
        return { ok: true, json: async () => ({ embedding: { values: vec(0.9) } }) } as any;
      }
      return { ok: true, json: async () => ({}), text: async () => '' } as any;
    }) as unknown as typeof fetch;
  });

  it('uses sequential Titan when the OpenAI batch call fails', async () => {
    const r = await generateBatchEmbeddings(['a', 'b', 'c']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.embeddings).toHaveLength(3);
      expect(r.model).toBe('amazon.titan-embed-text-v1');
    }
    expect(mockGenerateTitanEmbedding).toHaveBeenCalledTimes(3);
  });

  it('falls through to sequential Gemini as an incident when Titan batch also fails', async () => {
    titanOutcome = 'fail';
    const r = await generateBatchEmbeddings(['a', 'b']);
    expect(r.ok).toBe(true);

    const ev = emitted.find((e) => e.type === 'embedding.google_fallback_used');
    expect(ev).toBeDefined();
    expect(ev!.status).toBe('error');
    expect(ev!.payload.policy_violation).toBe(true);
  });
});
