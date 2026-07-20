/**
 * memory-facts-service — 768-dim fact-embedding generator
 * (BOOTSTRAP-MEMORY-DAILY-LEARNING)
 *
 * memory_facts.embedding is a FIXED vector(768) column (confirmed via
 * pg_attribute.atttypmod on staging 2026-07-06) — a different dimension
 * from memory_items.embedding's vector(1536) (embedding-service.ts,
 * VTID-01978). Before this fix, generateFactEmbeddingAsync reused the
 * shared 1536-dim embedding-service, and every OpenAI-generated embedding
 * was silently rejected by Postgres's vector-dimension check on write —
 * confirmed on staging: a batch of 100 valid 1536d vectors generated, 0
 * stored. These tests lock in the dimension-correct behavior: OpenAI is
 * requested at native 768d (the `dimensions` param), Gemini's
 * text-embedding-004 (native 768d) is the fallback.
 */

process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';

const fetchCalls: Array<{ url: string; body: any }> = [];
let openaiOk = true;
let openaiEmbeddings = [[0.1, 0.2, 0.3]];

global.fetch = jest.fn(async (url: any, opts: any) => {
  const body = opts?.body ? JSON.parse(opts.body) : undefined;
  fetchCalls.push({ url: String(url), body });

  if (String(url).includes('api.openai.com/v1/embeddings')) {
    if (!openaiOk) return { ok: false, status: 500, text: async () => 'openai down' } as any;
    return {
      ok: true,
      json: async () => ({ data: openaiEmbeddings.map((embedding) => ({ embedding })) }),
    } as any;
  }
  if (String(url).includes('generativelanguage.googleapis.com')) {
    return {
      ok: true,
      json: async () => ({ embedding: { values: [0.9, 0.8, 0.7] } }),
    } as any;
  }
  return { ok: false, status: 404, text: async () => 'not found' } as any;
}) as any;

import { generateFactEmbeddings } from '../../src/services/memory-facts-service';

describe('generateFactEmbeddings', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    openaiOk = true;
    openaiEmbeddings = [[0.1, 0.2, 0.3]];
  });

  it('requests native 768-dim output from OpenAI (not a post-hoc truncation)', async () => {
    const result = await generateFactEmbeddings(['user_name: Dragan']);
    expect(result.ok).toBe(true);
    expect(result.model).toBe('text-embedding-3-small');
    const call = fetchCalls.find((c) => c.url.includes('api.openai.com'));
    expect(call).toBeDefined();
    expect(call!.body.dimensions).toBe(768);
    expect(call!.body.model).toBe('text-embedding-3-small');
  });

  it('returns [] immediately for an empty input array without calling any provider', async () => {
    const result = await generateFactEmbeddings([]);
    expect(result).toEqual({ ok: true, embeddings: [] });
    expect(fetchCalls.length).toBe(0);
  });

  it('falls back to Gemini text-embedding-004 (native 768d) when OpenAI fails', async () => {
    openaiOk = false;
    const result = await generateFactEmbeddings(['user_name: Dragan']);
    expect(result.ok).toBe(true);
    expect(result.model).toBe('text-embedding-004');
    expect(result.embeddings).toEqual([[0.9, 0.8, 0.7]]);
  });

  it('reports failure when both providers fail', async () => {
    openaiOk = false;
    process.env.GOOGLE_GEMINI_API_KEY = '';
    const result = await generateFactEmbeddings(['x']);
    expect(result.ok).toBe(false);
    process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';
  });

  it('fails when OpenAI returns fewer embeddings than requested texts', async () => {
    openaiEmbeddings = [[0.1, 0.2, 0.3]]; // only 1, but we ask for 2
    const result = await generateFactEmbeddings(['a', 'b']);
    // Falls through to Gemini (looped one-by-one) since the OpenAI count mismatched.
    expect(result.ok).toBe(true);
    expect(result.model).toBe('text-embedding-004');
  });
});
