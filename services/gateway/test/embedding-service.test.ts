/**
 * VTID-04457: embedding-service embeds with Titan only.
 * VTID-04460: Titan V2, 1024 dims (the embedding_v2 columns).
 * No OpenAI call, no Gemini call, and failures are reported once.
 */
process.env.NODE_ENV = 'test';

const emitted: any[] = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: any) => { emitted.push(e); }),
}));

const cache = new Map<string, any>();
jest.mock('../src/services/embedding-cache', () => ({
  getCachedEmbedding: jest.fn((t: string) => cache.get(t) ?? null),
  setCachedEmbedding: jest.fn((t: string, vector: number[], model: string, dimensions: number) => cache.set(t, { vector, model, dimensions })),
  getCacheStats: jest.fn(() => ({})),
}));

let titanOk = true;
const mockTitan = jest.fn(async () => titanOk
  ? { ok: true, embedding: new Array(1024).fill(0.1), model: 'amazon.titan-embed-text-v2:0' }
  : { ok: false, error: 'invoke_failed: AccessDenied' });
jest.mock('../src/services/memory-embedding', () => ({
  embedMemoryText: (...a: any[]) => (mockTitan as any)(...a),
  MEMORY_EMBEDDING_MODEL: 'amazon.titan-embed-text-v2:0',
  MEMORY_EMBEDDING_DIMENSIONS: 1024,
}));

import {
  generateEmbedding, generateBatchEmbeddings, isEmbeddingServiceAvailable, EMBEDDING_DIMENSIONS,
} from '../src/services/embedding-service';

const fetchSpy = jest.spyOn(global, 'fetch' as any);

beforeEach(() => {
  emitted.length = 0; cache.clear(); titanOk = true;
  mockTitan.mockClear(); fetchSpy.mockClear();
  process.env.OPENAI_API_KEY = 'set-but-unused';
  process.env.GOOGLE_GEMINI_API_KEY = 'set-but-unused';
});

describe('generateEmbedding', () => {
  it('embeds with Titan and never calls OpenAI or Gemini, even with their keys set', async () => {
    const r = await generateEmbedding('hello');
    expect(r).toMatchObject({ ok: true, model: 'amazon.titan-embed-text-v2:0', dimensions: 1024 });
    expect(mockTitan).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it('serves a repeat from the cache', async () => {
    await generateEmbedding('same');
    const r = await generateEmbedding('same');
    expect(r.latency_ms).toBe(0);
    expect(mockTitan).toHaveBeenCalledTimes(1);
  });

  it('a Titan failure is ok:false with one error event naming the provider, no fallback', async () => {
    titanOk = false;
    const r = await generateEmbedding('x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('AccessDenied');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'embedding.all_providers_failed', status: 'error', payload: { provider: 'titan_bedrock' } });
    expect(emitted.some(e => e.type === 'embedding.google_fallback_used')).toBe(false);
  });
});

describe('generateBatchEmbeddings', () => {
  it('embeds each text with Titan, in order, and names the provider', async () => {
    const r = await generateBatchEmbeddings(['a', 'b', 'c']);
    expect(r.ok).toBe(true);
    expect(r.embeddings).toHaveLength(3);
    expect(mockTitan).toHaveBeenCalledTimes(3);
    expect(emitted.find(e => e.type === 'embedding.batch_generated')?.payload).toMatchObject({ provider: 'titan_bedrock', count: 3 });
  });

  it('fails as a whole rather than returning a partial list', async () => {
    titanOk = false;
    const r = await generateBatchEmbeddings(['a', 'b']);
    expect(r).toMatchObject({ ok: false });
    expect(r.embeddings).toBeUndefined();
  });

  it('empty input is ok with no call', async () => {
    expect(await generateBatchEmbeddings([])).toMatchObject({ ok: true, embeddings: [] });
    expect(mockTitan).not.toHaveBeenCalled();
  });
});

describe('isEmbeddingServiceAvailable', () => {
  it('reports Titan only, gated on BEDROCK_ROLE_ARN', () => {
    delete process.env.BEDROCK_ROLE_ARN;
    expect(isEmbeddingServiceAvailable()).toEqual({ available: false, providers: [] });
    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::1:role/x';
    expect(isEmbeddingServiceAvailable()).toEqual({ available: true, providers: ['titan_bedrock'] });
  });
});

describe('source guard', () => {
  it('embedding-service has no OpenAI or Google endpoint', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/embedding-service.ts'), 'utf8');
    expect(src).not.toMatch(/api\.openai\.com|generativelanguage\.googleapis\.com|OPENAI_API_KEY|GEMINI_API_KEY/);
  });
});
