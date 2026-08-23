/**
 * Embedding telemetry must name the provider (VTID-03579)
 *
 * `embedding.batch_generated` fired 1,384 times over 90 days recording count,
 * dimensions and latency — and never WHO produced the vectors. That is the same
 * blindness that let the Gemini bill hide behind a routing table: the table
 * states intent, only completion telemetry says who actually served the call.
 *
 * It matters more here than for a text completion. `memory_items.embedding` is
 * `vector(1536)`, and BOTH providers emit 1536 dimensions — so an OpenAI vector
 * and a Gemini vector insert equally happily and neither errors. They are not
 * comparable: different models embed into different semantic spaces, so cosine
 * similarity across a mixed set is quietly meaningless rather than wrong-looking.
 * `embedding.fallback_used` fired 495 times between 2026-05-27 and 2026-07-06
 * with none of this recorded, so which rows are affected is now unrecoverable
 * from telemetry alone. These tests exist so that never silently recurs.
 */

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';

const emitted: Array<{ type: string; payload: Record<string, unknown>; message?: string }> = [];
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async (e: { type: string; payload: Record<string, unknown>; message?: string }) => {
    emitted.push(e);
    return undefined;
  }),
}));

jest.mock('../src/services/embedding-cache', () => ({
  getCachedEmbedding: jest.fn(() => null),
  setCachedEmbedding: jest.fn(),
  getCacheStats: jest.fn(() => ({ hits: 0, misses: 0, size: 0 })),
}));

const vec = (n: number) => Array.from({ length: 1536 }, () => n);

let openaiOk = true;
const mockFetch = jest.fn(async (url: string) => {
  const u = String(url);
  if (u.includes('api.openai.com')) {
    if (!openaiOk) return { ok: false, status: 500, text: async () => 'openai down' } as any;
    return {
      ok: true,
      json: async () => ({
        data: [{ embedding: vec(0.1) }, { embedding: vec(0.2) }],
        model: 'text-embedding-3-small',
      }),
    } as any;
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    return {
      ok: true,
      json: async () => ({ embedding: { values: vec(0.9) } }),
    } as any;
  }
  return { ok: true, json: async () => ({}), text: async () => '' } as any;
});
global.fetch = mockFetch as unknown as typeof fetch;

import {
  generateBatchEmbeddings,
  generateEmbedding,
} from '../src/services/embedding-service';

describe('embedding telemetry records the provider (VTID-03579)', () => {
  beforeEach(() => {
    emitted.length = 0;
    mockFetch.mockClear();
    openaiOk = true;
  });

  it('names provider and model on a successful batch', async () => {
    const r = await generateBatchEmbeddings(['alpha', 'beta']);
    expect(r.ok).toBe(true);

    const ev = emitted.find((e) => e.type === 'embedding.batch_generated');
    expect(ev).toBeDefined();
    expect(ev!.payload.provider).toBe('openai');
    expect(ev!.payload.model).toBe('text-embedding-3-small');

    // The pre-existing fields must survive — this is an addition, not a rewrite,
    // and anything already reading count/dimensions/latency keeps working.
    expect(ev!.payload.count).toBe(2);
    expect(ev!.payload.dimensions).toBe(1536);
    expect(ev!.payload).toHaveProperty('latency_ms');
  });

  it('names provider, model AND dimensions when Gemini serves the fallback', async () => {
    openaiOk = false;

    const r = await generateEmbedding('alpha');
    expect(r.ok).toBe(true);

    const ev = emitted.find((e) => e.type === 'embedding.fallback_used');
    expect(ev).toBeDefined();
    expect(ev!.payload.provider).toBe('gemini');
    expect(ev!.payload.model).toBeTruthy();
    // Dimensions specifically: a Gemini vector that happens to be 1536 long
    // inserts into the same column as an OpenAI one without error, so the
    // dimension is the only thing distinguishing "compatible shape" from
    // "compatible meaning" — and it does not distinguish the latter at all.
    // Recording it is what makes the ambiguity auditable later.
    expect(ev!.payload.dimensions).toBe(1536);
    expect(ev!.payload).toHaveProperty('openai_error');
  });

  it('does not emit a fallback event when OpenAI succeeds', async () => {
    await generateEmbedding('alpha');
    // A fallback event is a signal that vectors from a second semantic space
    // entered the store. It must never fire on the happy path, or the signal is
    // worthless for identifying affected rows.
    expect(emitted.find((e) => e.type === 'embedding.fallback_used')).toBeUndefined();
  });
});
