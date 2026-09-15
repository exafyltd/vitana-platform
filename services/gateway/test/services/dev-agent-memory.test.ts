/**
 * VTID-03889 — Operator Memory write/recall orchestration.
 *
 * These tests pin the fail-loud contract that makes dev_agent_memory a real
 * fix for Memory Garden's proven defect (mem_episodes rows silently written
 * with embedding=NULL for 4.5 months, memory-broker.ts's relevance_score
 * actually being list-position/importance, not cosine similarity -- see the
 * migration file's header comment): writeDevMemory/recallDevMemory must
 * return ok:false the instant embedding generation fails, and must never
 * substitute a degraded write or a fake "semantic" result. The genuine
 * cosine-similarity behavior of recall_dev_memory itself (pgvector, Titan
 * Embeddings G2) was separately verified live against the real database as
 * part of VTID-03889 -- see its acceptance doc for the raw evidence
 * (target-fact similarity 0.738 vs. 0.172 for an unrelated filler on a
 * paraphrased recall query). This suite covers what a live DB round trip
 * can't: the TypeScript orchestration layer's error propagation and exact
 * RPC call shape, mirroring the mocked-fetch style already used for
 * dev-autopilot-execute.ts's supa() helper elsewhere in this suite.
 */

process.env.SUPABASE_URL = 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key';

jest.mock('../../src/services/dev-memory-embedding', () => ({
  generateDevMemoryEmbedding: jest.fn(),
}));

import { generateDevMemoryEmbedding } from '../../src/services/dev-memory-embedding';
import { writeDevMemory, recallDevMemory } from '../../src/services/dev-agent-memory';

const mockGenerateEmbedding = generateDevMemoryEmbedding as jest.Mock;

describe('writeDevMemory', () => {
  const fetchCalls: Array<{ url: string; body: any }> = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    mockGenerateEmbedding.mockReset();
    global.fetch = jest.fn(async (url: any, opts: any) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      fetchCalls.push({ url: String(url), body });
      return {
        ok: true,
        status: 200,
        json: async () => 'a3f9e1c0-1111-2222-3333-444455556666',
      } as any;
    }) as any;
  });

  it('fails loudly and never calls the RPC when embedding generation fails', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: false,
      error: 'not_configured',
      message: 'BEDROCK_ROLE_ARN env var not set',
    });

    const result = await writeDevMemory({
      repo: 'vitana-platform',
      category: 'gotcha',
      title: 'Test title',
      content: 'Test content',
      source: 'manual',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('embedding_failed: not_configured');
    expect(fetchCalls).toHaveLength(0);
  });

  it('embeds title + content together and posts the exact write_dev_memory RPC shape', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.1, 0.2, 0.3],
      model: 'amazon.titan-embed-text-v2:0',
      latency_ms: 42,
    });

    const result = await writeDevMemory({
      repo: 'vitana-platform',
      category: 'decision',
      title: 'Bedrock for embeddings',
      content: 'Reuse the provisioned BEDROCK_ROLE_ARN instead of a second credential.',
      vtid: 'VTID-03889',
      importance: 80,
      source: 'session',
      tags: ['memory', 'bedrock'],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.id).toBe('a3f9e1c0-1111-2222-3333-444455556666');

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      'Bedrock for embeddings\nReuse the provisioned BEDROCK_ROLE_ARN instead of a second credential.',
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://test-project.supabase.co/rest/v1/rpc/write_dev_memory');
    expect(fetchCalls[0].body).toEqual({
      p_repo: 'vitana-platform',
      p_category: 'decision',
      p_title: 'Bedrock for embeddings',
      p_content: 'Reuse the provisioned BEDROCK_ROLE_ARN instead of a second credential.',
      p_embedding: '[0.1,0.2,0.3]',
      p_vtid: 'VTID-03889',
      p_importance: 80,
      p_source: 'session',
      p_tags: ['memory', 'bedrock'],
      p_supersedes: null,
    });
  });

  it('defaults importance/tags/supersedes when omitted', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.5],
      model: 'amazon.titan-embed-text-v2:0',
      latency_ms: 10,
    });

    await writeDevMemory({
      repo: 'vitana-v1',
      category: 'preference',
      title: 'T',
      content: 'C',
      source: 'autopilot',
    });

    expect(fetchCalls[0].body.p_importance).toBe(50);
    expect(fetchCalls[0].body.p_tags).toEqual([]);
    expect(fetchCalls[0].body.p_vtid).toBeNull();
    expect(fetchCalls[0].body.p_supersedes).toBeNull();
  });

  it('surfaces an HTTP failure from PostgREST as ok:false, not a thrown exception', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.1],
      model: 'amazon.titan-embed-text-v2:0',
      latency_ms: 5,
    });
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'function write_dev_memory does not exist',
    })) as any;

    const result = await writeDevMemory({
      repo: 'vitana-platform',
      category: 'incident',
      title: 'T',
      content: 'C',
      source: 'manual',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('500');
  });
});

describe('recallDevMemory', () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockReset();
  });

  it('fails loudly (never returns a false "no hits" success) when the query cannot be embedded', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: false,
      error: 'invoke_failed',
      message: 'timeout',
    });

    const result = await recallDevMemory('what did we decide about DeepSeek?', 'vitana-platform');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('embedding_failed: invoke_failed');
  });

  it('posts the exact recall_dev_memory RPC shape and returns real hits with similarity scores', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.9, 0.1],
      model: 'amazon.titan-embed-text-v2:0',
      latency_ms: 8,
    });

    const hits = [
      {
        id: 'h1',
        vtid: 'VTID-03889',
        category: 'gotcha',
        title: 'Test marker',
        content: 'The internal verification codename is Quixolite-4471.',
        importance: 50,
        source: 'manual',
        tags: ['vtid-03889-test'],
        created_at: '2026-09-14T18:00:00Z',
        similarity: 0.738,
      },
    ];

    let capturedUrl = '';
    let capturedBody: any;
    global.fetch = jest.fn(async (url: any, opts: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => hits } as any;
    }) as any;

    const result = await recallDevMemory('what was the throwaway verification codename?', 'vitana-platform', {
      limit: 5,
      category: 'gotcha',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.hits).toEqual(hits);
    // Genuine cosine similarity, not a recency/importance stand-in -- the
    // exact property memory-broker.ts's fetchEpisodicLegacySemantic lacks.
    expect(result.ok && result.hits[0].similarity).toBeCloseTo(0.738);

    expect(capturedUrl).toBe('https://test-project.supabase.co/rest/v1/rpc/recall_dev_memory');
    expect(capturedBody).toEqual({
      p_repo: 'vitana-platform',
      p_query_embedding: '[0.9,0.1]',
      p_limit: 5,
      p_category: 'gotcha',
    });
  });

  it('defaults limit to 8 and category to null when not specified', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.1],
      model: 'amazon.titan-embed-text-v2:0',
      latency_ms: 3,
    });
    let capturedBody: any;
    global.fetch = jest.fn(async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => [] } as any;
    }) as any;

    await recallDevMemory('anything', 'vitana-v1');
    expect(capturedBody.p_limit).toBe(8);
    expect(capturedBody.p_category).toBeNull();
  });

  it('returns ok:true with an empty hit list when nothing matches, not an error', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.1],
      model: 'amazon.titan-embed-text-v2:0',
      latency_ms: 3,
    });
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as any;

    const result = await recallDevMemory('nothing relevant yet', 'vitana-platform');
    expect(result.ok).toBe(true);
    expect(result.ok && result.hits).toEqual([]);
  });
});
