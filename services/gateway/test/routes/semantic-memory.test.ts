/**
 * Tests for src/routes/semantic-memory.ts (VTID-01184).
 *
 * Mounted at /api/v1/memory in src/index.ts, with NO auth middleware in
 * front of it (verified by reading the router + its mount call — unlike
 * most admin routes in this codebase it does not use requireAuth /
 * requireExafyAdmin). Tenant/user scoping for this surface is therefore
 * enforced entirely by the required `lens.tenant_id` / `lens.user_id`
 * fields on every request body (validated by zod as UUIDs) and by
 * whatever the downstream service does with them — which is exactly what
 * we assert here: the exact lens is forwarded to the service layer
 * untouched, and a request that omits/malforms it is rejected by zod
 * BEFORE any service call is made.
 */
import request from 'supertest';
import express from 'express';

const mockSemanticSearch = jest.fn();
const mockWriteMemoryItem = jest.fn();
const mockBuildSemanticContext = jest.fn();
const mockGetItemsNeedingEmbeddings = jest.fn();
const mockUpdateEmbeddings = jest.fn();
const mockMarkForReembed = jest.fn();

jest.mock('../../src/services/supabase-semantic-memory', () => ({
  semanticSearch: (...args: unknown[]) => mockSemanticSearch(...args),
  writeMemoryItem: (...args: unknown[]) => mockWriteMemoryItem(...args),
  buildSemanticContext: (...args: unknown[]) => mockBuildSemanticContext(...args),
  getItemsNeedingEmbeddings: (...args: unknown[]) => mockGetItemsNeedingEmbeddings(...args),
  updateEmbeddings: (...args: unknown[]) => mockUpdateEmbeddings(...args),
  markForReembed: (...args: unknown[]) => mockMarkForReembed(...args),
  VTID: 'VTID-01184',
  EMBEDDING_DIMENSIONS: 1536,
}));

const mockGenerateEmbedding = jest.fn();
const mockGenerateBatchEmbeddings = jest.fn();
const mockIsEmbeddingServiceAvailable = jest.fn();

jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  generateBatchEmbeddings: (...args: unknown[]) => mockGenerateBatchEmbeddings(...args),
  isEmbeddingServiceAvailable: (...args: unknown[]) => mockIsEmbeddingServiceAvailable(...args),
}));

const mockEmitOasisEvent = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

import router from '../../src/routes/semantic-memory';

const app = express();
app.use(express.json());
app.use('/', router);

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const USER_A = '22222222-2222-2222-2222-222222222222';
const TENANT_B = '33333333-3333-3333-3333-333333333333';
const USER_B = '44444444-4444-4444-4444-444444444444';

const lensFor = (tenant_id: string, user_id: string) => ({
  tenant_id,
  user_id,
  workspace_scope: 'product' as const,
});

const EMBEDDING = Array.from({ length: 1536 }, () => 0.01);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENVIRONMENT;
  mockEmitOasisEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// POST /semantic/search
// ---------------------------------------------------------------------------

describe('POST /semantic/search', () => {
  it('rejects a request with no lens at all before calling any service (400, no downstream call)', async () => {
    const res = await request(app).post('/semantic/search').send({ query: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('rejects a lens with a non-UUID tenant_id/user_id before calling any service', async () => {
    const res = await request(app)
      .post('/semantic/search')
      .send({ query: 'hello', lens: { tenant_id: 'not-a-uuid', user_id: 'also-not-a-uuid', workspace_scope: 'product' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('generates a query embedding when none is supplied, then forwards the EXACT lens through to semanticSearch', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: true, embedding: EMBEDDING, model: 'text-embedding-3-small' });
    mockSemanticSearch.mockResolvedValue({ ok: true, results: [], query: 'hello', total_found: 0 });

    const res = await request(app)
      .post('/semantic/search')
      .send({ query: 'hello', lens: lensFor(TENANT_A, USER_A) });

    expect(res.status).toBe(200);
    expect(mockGenerateEmbedding).toHaveBeenCalledWith('hello');
    expect(mockSemanticSearch).toHaveBeenCalledTimes(1);
    const call = mockSemanticSearch.mock.calls[0][0];
    expect(call.lens.tenant_id).toBe(TENANT_A);
    expect(call.lens.user_id).toBe(USER_A);
    expect(call.query_embedding).toEqual(EMBEDDING);
  });

  it('never mixes tenants: two requests with different lenses hit the service with their own tenant_id/user_id, not the other request\'s', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: true, embedding: EMBEDDING, model: 'm' });
    mockSemanticSearch.mockResolvedValue({ ok: true, results: [], query: 'q', total_found: 0 });

    await request(app).post('/semantic/search').send({ query: 'q', lens: lensFor(TENANT_A, USER_A) });
    await request(app).post('/semantic/search').send({ query: 'q', lens: lensFor(TENANT_B, USER_B) });

    expect(mockSemanticSearch).toHaveBeenCalledTimes(2);
    expect(mockSemanticSearch.mock.calls[0][0].lens.tenant_id).toBe(TENANT_A);
    expect(mockSemanticSearch.mock.calls[1][0].lens.tenant_id).toBe(TENANT_B);
  });

  it('skips embedding generation when query_embedding is already supplied', async () => {
    mockSemanticSearch.mockResolvedValue({ ok: true, results: [], query: 'hello', total_found: 0 });
    await request(app)
      .post('/semantic/search')
      .send({ query: 'hello', query_embedding: EMBEDDING, lens: lensFor(TENANT_A, USER_A) });
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('returns 500 EMBEDDING_GENERATION_FAILED when embedding generation fails, without calling semanticSearch', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: false, error: 'provider down' });
    const res = await request(app)
      .post('/semantic/search')
      .send({ query: 'hello', lens: lensFor(TENANT_A, USER_A) });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('EMBEDDING_GENERATION_FAILED');
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('propagates a service-layer failure as 500', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: true, embedding: EMBEDDING, model: 'm' });
    mockSemanticSearch.mockResolvedValue({ ok: false, error: 'DB_ERROR' });
    const res = await request(app)
      .post('/semantic/search')
      .send({ query: 'hello', lens: lensFor(TENANT_A, USER_A) });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB_ERROR');
  });
});

// ---------------------------------------------------------------------------
// POST /semantic/write
// ---------------------------------------------------------------------------

describe('POST /semantic/write', () => {
  it('rejects a write with no lens before calling writeMemoryItem', async () => {
    const res = await request(app)
      .post('/semantic/write')
      .send({ content: 'hello world this is content', source: 'orb_text' });
    expect(res.status).toBe(400);
    expect(mockWriteMemoryItem).not.toHaveBeenCalled();
  });

  it('rejects an invalid source enum value', async () => {
    const res = await request(app)
      .post('/semantic/write')
      .send({ content: 'hello world this is content', source: 'not_a_valid_source', lens: lensFor(TENANT_A, USER_A) });
    expect(res.status).toBe(400);
    expect(mockWriteMemoryItem).not.toHaveBeenCalled();
  });

  it('forwards the exact lens to writeMemoryItem on a valid write, and 201s', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: true, embedding: EMBEDDING, model: 'text-embedding-3-small' });
    mockWriteMemoryItem.mockResolvedValue({ ok: true, id: 'mem-1' });

    const res = await request(app)
      .post('/semantic/write')
      .send({ content: 'the user really likes hiking', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });

    expect(res.status).toBe(201);
    expect(mockWriteMemoryItem).toHaveBeenCalledTimes(1);
    const call = mockWriteMemoryItem.mock.calls[0][0];
    expect(call.lens.tenant_id).toBe(TENANT_A);
    expect(call.lens.user_id).toBe(USER_A);
    expect(call.content).toBe('the user really likes hiking');
  });

  it('does not fail the write when embedding generation fails (embedding stays undefined)', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: false, error: 'provider down' });
    mockWriteMemoryItem.mockResolvedValue({ ok: true, id: 'mem-2' });

    const res = await request(app)
      .post('/semantic/write')
      .send({ content: 'the user really likes hiking', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });

    expect(res.status).toBe(201);
    const call = mockWriteMemoryItem.mock.calls[0][0];
    expect(call.embedding).toBeUndefined();
  });

  it('skips embedding generation entirely for very short content (<=10 chars)', async () => {
    mockWriteMemoryItem.mockResolvedValue({ ok: true, id: 'mem-3' });
    await request(app)
      .post('/semantic/write')
      .send({ content: 'short', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('propagates a write failure as 500', async () => {
    mockWriteMemoryItem.mockResolvedValue({ ok: false, error: 'DB_ERROR' });
    const res = await request(app)
      .post('/semantic/write')
      .send({ content: 'the user really likes hiking', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /semantic/context
// ---------------------------------------------------------------------------

describe('POST /semantic/context', () => {
  it('rejects a request with no lens before calling any service', async () => {
    const res = await request(app).post('/semantic/context').send({ query: 'sleep tips' });
    expect(res.status).toBe(400);
    expect(mockBuildSemanticContext).not.toHaveBeenCalled();
  });

  it('builds context using the generated embedding and the exact lens', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: true, embedding: EMBEDDING, model: 'm' });
    mockBuildSemanticContext.mockResolvedValue({ ok: true, context: 'CTX', results: [{ id: '1' }] });

    const res = await request(app)
      .post('/semantic/context')
      .send({ query: 'sleep tips', lens: lensFor(TENANT_A, USER_A) });

    expect(res.status).toBe(200);
    expect(res.body.context).toBe('CTX');
    expect(res.body.results_count).toBe(1);
    expect(mockBuildSemanticContext).toHaveBeenCalledWith('sleep tips', EMBEDDING, expect.objectContaining({ tenant_id: TENANT_A, user_id: USER_A }), 10);
  });

  it('returns 500 when embedding generation fails, without calling buildSemanticContext', async () => {
    mockGenerateEmbedding.mockResolvedValue({ ok: false, error: 'down' });
    const res = await request(app)
      .post('/semantic/context')
      .send({ query: 'sleep tips', lens: lensFor(TENANT_A, USER_A) });
    expect(res.status).toBe(500);
    expect(mockBuildSemanticContext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /semantic/health
// ---------------------------------------------------------------------------

describe('GET /semantic/health', () => {
  it('reports embedding service availability', async () => {
    mockIsEmbeddingServiceAvailable.mockReturnValue({ available: true, providers: ['openai'] });
    const res = await request(app).get('/semantic/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.embedding_dimensions).toBe(1536);
    expect(res.body.embedding_service).toEqual({ available: true, providers: ['openai'] });
  });
});

// ---------------------------------------------------------------------------
// POST /admin/embeddings/generate
// ---------------------------------------------------------------------------

describe('POST /admin/embeddings/generate', () => {
  it('reports zero processed when no items need embeddings', async () => {
    mockGetItemsNeedingEmbeddings.mockResolvedValue({ ok: true, items: [] });
    const res = await request(app).post('/admin/embeddings/generate').send({});
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(0);
    expect(mockGenerateBatchEmbeddings).not.toHaveBeenCalled();
  });

  it('processes items in batches and emits an OASIS event on success', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `item-${i}`, content: `content ${i}` }));
    mockGetItemsNeedingEmbeddings.mockResolvedValue({ ok: true, items });
    mockGenerateBatchEmbeddings.mockResolvedValue({ ok: true, embeddings: items.map(() => EMBEDDING), model: 'text-embedding-3-small' });
    mockUpdateEmbeddings.mockResolvedValue({ ok: true, updated_count: 3 });

    const res = await request(app).post('/admin/embeddings/generate').send({ limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(3);
    expect(res.body.errors).toBe(0);
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitOasisEvent.mock.calls[0][0].status).toBe('success');
  });

  it('counts a failed batch as errors and still returns 200 with status=warning', async () => {
    mockGetItemsNeedingEmbeddings.mockResolvedValue({ ok: true, items: [{ id: 'i1', content: 'x' }] });
    mockGenerateBatchEmbeddings.mockResolvedValue({ ok: false, error: 'rate limited' });

    const res = await request(app).post('/admin/embeddings/generate').send({});

    expect(res.status).toBe(200);
    expect(res.body.errors).toBe(1);
    expect(res.body.processed).toBe(0);
    expect(mockEmitOasisEvent.mock.calls[0][0].status).toBe('warning');
  });

  it('rejects an out-of-range limit', async () => {
    const res = await request(app).post('/admin/embeddings/generate').send({ limit: 99999 });
    expect(res.status).toBe(400);
    expect(mockGetItemsNeedingEmbeddings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /admin/embeddings/reembed
// ---------------------------------------------------------------------------

describe('POST /admin/embeddings/reembed', () => {
  it('forwards tenant_id/user_id scoping filters to markForReembed', async () => {
    mockMarkForReembed.mockResolvedValue({ ok: true, marked_count: 5 });
    const res = await request(app)
      .post('/admin/embeddings/reembed')
      .send({ tenant_id: TENANT_A, user_id: USER_A });
    expect(res.status).toBe(200);
    expect(mockMarkForReembed).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_A, user_id: USER_A }),
    );
  });

  it('rejects a malformed tenant_id', async () => {
    const res = await request(app).post('/admin/embeddings/reembed').send({ tenant_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(mockMarkForReembed).not.toHaveBeenCalled();
  });

  it('propagates a service failure as 500', async () => {
    mockMarkForReembed.mockResolvedValue({ ok: false, error: 'boom' });
    const res = await request(app).post('/admin/embeddings/reembed').send({});
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/embeddings/status
// ---------------------------------------------------------------------------

describe('GET /admin/embeddings/status', () => {
  it('reports items_needing_embeddings=true when the sample query returns items', async () => {
    mockGetItemsNeedingEmbeddings.mockResolvedValue({ ok: true, items: [{ id: 'x', content: 'y' }] });
    mockIsEmbeddingServiceAvailable.mockReturnValue({ available: true, providers: ['openai'] });
    const res = await request(app).get('/admin/embeddings/status');
    expect(res.status).toBe(200);
    expect(res.body.items_needing_embeddings).toBe(true);
    expect(res.body.migration_available).toBe(true);
  });

  it('reports migration_available=false when the underlying query fails', async () => {
    mockGetItemsNeedingEmbeddings.mockResolvedValue({ ok: false, error: 'no column' });
    mockIsEmbeddingServiceAvailable.mockReturnValue({ available: false, providers: [] });
    const res = await request(app).get('/admin/embeddings/status');
    expect(res.status).toBe(200);
    expect(res.body.migration_available).toBe(false);
    expect(res.body.items_needing_embeddings).toBe('unknown');
  });
});
