// VTID-03155 — unit tests for the CPB-3 fetchers added to
// `memory-facts-service.ts`.
//
// Contract under test:
//   - `searchFactsSemantic(lens, query, options?)` — Tier 2 cosine
//     search via the `memory_facts_semantic_search` RPC. Guards:
//       * env (SUPABASE_URL / SUPABASE_SERVICE_ROLE) → must short-circuit
//       * lens.tenant_id / lens.user_id → must short-circuit
//       * query length ≤ 3 → returns empty (ok=true)
//       * embedding failure → returns empty (ok=false, error='embedding_failed')
//       * RPC non-ok → returns empty (ok=false, error='rpc_http_<status>')
//       * RPC ok → returns the rows with `similarity_score` preserved
//   - `listFactsByConfidence(lens, options?)` — Tier 3 confidence +
//     recency-sorted REST select against `memory_facts`. Guards:
//       * env / lens short-circuit
//       * URL includes the `superseded_by=is.null` filter and the
//         `provenance_confidence.desc,extracted_at.desc` order
//       * REST non-ok → returns empty (ok=false, error='rest_http_<status>')
//       * REST ok → returns the rows as-is

// `searchFactsSemantic` lazy-imports the embedding service so the file
// stays loadable in environments where embeddings aren't configured.
// Mock it before any imports of the module under test.
jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn(),
}));

import {
  searchFactsSemantic,
  listFactsByConfidence,
} from '../../src/services/memory-facts-service';
import { generateEmbedding } from '../../src/services/embedding-service';

const mockedEmbedding = generateEmbedding as jest.MockedFunction<
  typeof generateEmbedding
>;
const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;

const LENS = {
  tenant_id: 'tenant-aaa',
  user_id: 'user-bbb',
};

beforeEach(() => {
  mockedEmbedding.mockReset();
  mockedFetch.mockReset();
});

// ---------------------------------------------------------------------------
// searchFactsSemantic
// ---------------------------------------------------------------------------

describe('VTID-03155 searchFactsSemantic', () => {
  it('returns empty (ok=false, error=supabase_not_configured) when env is missing', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await searchFactsSemantic(LENS, 'hello world question');
      expect(r.ok).toBe(false);
      expect(r.facts).toEqual([]);
      expect(r.error).toBe('supabase_not_configured');
    } finally {
      process.env.SUPABASE_URL = prevUrl;
    }
  });

  it('returns empty (ok=false, error=missing_lens) when lens has no tenant/user', async () => {
    const r = await searchFactsSemantic({}, 'hello world question');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_lens');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns empty (ok=true, no error) for short queries — no embedding call', async () => {
    const r = await searchFactsSemantic(LENS, 'hi');
    expect(r.ok).toBe(true);
    expect(r.facts).toEqual([]);
    expect(mockedEmbedding).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns empty when embedding generation fails', async () => {
    mockedEmbedding.mockResolvedValueOnce({ ok: false, error: 'fake' } as any);
    const r = await searchFactsSemantic(LENS, 'a meaningful query string');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('embedding_failed');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns rpc_http_<status> when the RPC responds non-ok', async () => {
    mockedEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.1, 0.2, 0.3],
    } as any);
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as any);
    const r = await searchFactsSemantic(LENS, 'a meaningful query string');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('rpc_http_503');
  });

  it('returns the RPC rows verbatim on success (with similarity_score)', async () => {
    mockedEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.4, 0.5, 0.6],
    } as any);
    const rows = [
      {
        id: 'fact-1',
        fact_key: 'user_name',
        fact_value: 'Dragan',
        entity: 'self',
        provenance_confidence: 0.98,
        provenance_source: 'user_stated',
        similarity_score: 0.91,
      },
      {
        id: 'fact-2',
        fact_key: 'fiancee_name',
        fact_value: 'Anna',
        entity: 'disclosed',
        provenance_confidence: 0.85,
        provenance_source: 'assistant_inferred',
        similarity_score: 0.74,
      },
    ];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => rows,
    } as any);
    const r = await searchFactsSemantic(LENS, 'tell me about my partner');
    expect(r.ok).toBe(true);
    expect(r.facts).toEqual(rows);
  });

  it('sends the canonical RPC body: top_k=20, min_confidence=0.5, lens ids', async () => {
    mockedEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: [0.4, 0.5, 0.6],
    } as any);
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as any);
    await searchFactsSemantic(LENS, 'a meaningful query string');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('/rest/v1/rpc/memory_facts_semantic_search');
    const body = JSON.parse((init as any).body);
    expect(body.p_top_k).toBe(20);
    expect(body.p_min_confidence).toBe(0.5);
    expect(body.p_tenant_id).toBe(LENS.tenant_id);
    expect(body.p_user_id).toBe(LENS.user_id);
    // p_query_embedding is JSON-stringified for the pgvector parameter
    expect(typeof body.p_query_embedding).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// listFactsByConfidence
// ---------------------------------------------------------------------------

describe('VTID-03155 listFactsByConfidence', () => {
  it('returns empty when env is missing', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      const r = await listFactsByConfidence(LENS);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('supabase_not_configured');
    } finally {
      process.env.SUPABASE_URL = prevUrl;
    }
  });

  it('returns empty when lens is missing tenant/user', async () => {
    const r = await listFactsByConfidence({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_lens');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('builds the canonical URL: superseded filter + confidence/recency order + limit', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as any);
    await listFactsByConfidence(LENS, { limit: 25 });
    const [url] = mockedFetch.mock.calls[0];
    const u = String(url);
    expect(u).toContain('/rest/v1/memory_facts');
    expect(u).toContain(`tenant_id=eq.${LENS.tenant_id}`);
    expect(u).toContain(`user_id=eq.${LENS.user_id}`);
    expect(u).toContain('superseded_by=is.null');
    expect(u).toContain('order=provenance_confidence.desc,extracted_at.desc');
    expect(u).toContain('limit=25');
  });

  it('returns rest_http_<status> on non-ok response', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as any);
    const r = await listFactsByConfidence(LENS);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('rest_http_401');
  });

  it('returns the rows verbatim on success', async () => {
    const rows = [
      {
        id: 'fact-9',
        fact_key: 'user_birthday',
        fact_value: '1969-09-09',
        entity: 'self',
        provenance_confidence: 0.95,
        provenance_source: 'user_stated',
      },
    ];
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => rows,
    } as any);
    const r = await listFactsByConfidence(LENS);
    expect(r.ok).toBe(true);
    expect(r.facts).toEqual(rows);
  });

  it('defaults to limit=50 when none provided', async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as any);
    await listFactsByConfidence(LENS);
    const [url] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('limit=50');
  });
});
