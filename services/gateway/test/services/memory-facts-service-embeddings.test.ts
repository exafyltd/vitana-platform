/**
 * VTID-04342 — fact embeddings use the single memory embedder:
 * Amazon Titan Text Embeddings V2 (1024-dim) via Bedrock.
 *
 * Replaces the BOOTSTRAP-MEMORY-DAILY-LEARNING OpenAI → Gemini 768-dim path.
 * Neither key exists on AWS, so no fact had been embedded since 2026-04-28,
 * and the Gemini leg was a standing Google-dependency violation. These tests
 * pin: Titan is the only provider, no OpenAI/Google HTTP call is ever made,
 * and a per-text failure comes back as a null slot (so AP-0910 stores the
 * rest and retries that one) rather than failing the batch.
 */

const mockDevEmbed = jest.fn();
jest.mock('../../src/services/dev-memory-embedding', () => ({
  generateDevMemoryEmbedding: (...args: unknown[]) => mockDevEmbed(...args),
}));

const fetchCalls: string[] = [];
global.fetch = jest.fn(async (url: any) => {
  fetchCalls.push(String(url));
  return { ok: false, status: 404, text: async () => 'not found' } as any;
}) as any;

import { generateFactEmbeddings } from '../../src/services/memory-facts-service';
import {
  embedMemoryText,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL,
} from '../../src/services/memory-embedding';

const vec = (v: number) => new Array(1024).fill(v);

describe('generateFactEmbeddings (Titan V2)', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    mockDevEmbed.mockReset();
    mockDevEmbed.mockResolvedValue({ ok: true, embedding: vec(0.1), model: MEMORY_EMBEDDING_MODEL, latency_ms: 5 });
  });

  it('pins the model and dimension', () => {
    expect(MEMORY_EMBEDDING_MODEL).toBe('amazon.titan-embed-text-v2:0');
    expect(MEMORY_EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it('embeds with Titan and never calls OpenAI or Google', async () => {
    const result = await generateFactEmbeddings(['user_name: Dragan', 'child_name: Mia']);
    expect(result.ok).toBe(true);
    expect(result.model).toBe('amazon.titan-embed-text-v2:0');
    expect(result.embeddings).toHaveLength(2);
    expect(mockDevEmbed).toHaveBeenCalledWith('user_name: Dragan');
    expect(mockDevEmbed).toHaveBeenCalledWith('child_name: Mia');
    expect(fetchCalls.filter((u) => /openai|googleapis/.test(u))).toEqual([]);
  });

  it('returns [] immediately for an empty input array without calling any provider', async () => {
    const result = await generateFactEmbeddings([]);
    expect(result).toEqual({ ok: true, embeddings: [] });
    expect(mockDevEmbed).not.toHaveBeenCalled();
  });

  it('keeps order and returns null for the one text that failed', async () => {
    mockDevEmbed
      .mockResolvedValueOnce({ ok: true, embedding: vec(0.1), model: MEMORY_EMBEDDING_MODEL, latency_ms: 5 })
      .mockResolvedValueOnce({ ok: false, error: 'invoke_failed', message: 'throttled' })
      .mockResolvedValueOnce({ ok: true, embedding: vec(0.3), model: MEMORY_EMBEDDING_MODEL, latency_ms: 5 });
    const result = await generateFactEmbeddings(['a', 'b', 'c']);
    expect(result.ok).toBe(true);
    expect(result.embeddings![0]![0]).toBe(0.1);
    expect(result.embeddings![1]).toBeNull();
    expect(result.embeddings![2]![0]).toBe(0.3);
  });

  it('reports failure when every text fails (e.g. Bedrock not configured)', async () => {
    mockDevEmbed.mockResolvedValue({ ok: false, error: 'not_configured', message: 'BEDROCK_ROLE_ARN env var not set' });
    const result = await generateFactEmbeddings(['x', 'y']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not_configured');
  });

  it('embedMemoryText rejects empty text without calling Bedrock', async () => {
    const result = await embedMemoryText('   ');
    expect(result.ok).toBe(false);
    expect(mockDevEmbed).not.toHaveBeenCalled();
  });
});
