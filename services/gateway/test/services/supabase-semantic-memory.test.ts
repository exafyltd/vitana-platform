/**
 * VTID-01184: Supabase Semantic Memory Service (pgvector-backed)
 *
 * Coverage:
 * - semanticSearch(): Context Lens validation, embedding-dimension guard,
 *   "Supabase not configured" short-circuit, RPC-not-found vs. generic RPC
 *   error handling, result-row mapping, and — critically — that the
 *   tenant_id/user_id from the Context Lens are the values forwarded to
 *   the memory_semantic_search RPC (the DB-side hard filter this client
 *   must never drop or swap for a different lens).
 * - writeMemoryItem(): lens validation, v2→v1 RPC fallback, embedding
 *   inclusion/exclusion by dimension, OASIS event only on ok:true.
 * - getItemsNeedingEmbeddings() / updateEmbeddings() / markForReembed():
 *   not-configured guard, RPC-not-found guard, success mapping.
 * - buildSemanticContext(): delegates to semanticSearch, formats results
 *   into a prompt-ready string with category grouping/ordering and
 *   relevance markers.
 * - createServiceClient() / exported constants.
 *
 * Mocks '@supabase/supabase-js' the same way test/d50-positive-trajectory-
 * reinforcement.test.ts does: createClient() returns an object exposing
 * only the `rpc` method this service actually calls.
 */

process.env.NODE_ENV = 'test';

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

const mockRpc = jest.fn();
const mockCreateClient = jest.fn().mockReturnValue({ rpc: mockRpc });
jest.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}));

import { createContextLens, ContextLens } from '../../src/types/context-lens';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const EMBEDDING_1536 = new Array(1536).fill(0.001);

function lensFor(tenant: string, user: string, opts?: Partial<ContextLens>): ContextLens {
  return createContextLens(tenant, user, { workspace_scope: 'product', ...opts });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  delete process.env.SUPABASE_SERVICE_ROLE;
});

// Fresh module per test file section isn't required here: none of the
// functions under test read env vars at import time (they call
// createServiceClient() per-invocation), so we import once at top level.
import * as svc from '../../src/services/supabase-semantic-memory';

// =============================================================================
// semanticSearch()
// =============================================================================

describe('semanticSearch()', () => {
  it('rejects an invalid Context Lens without touching Supabase', async () => {
    const result = await svc.semanticSearch({
      query: 'q',
      query_embedding: EMBEDDING_1536,
      lens: { tenant_id: '', user_id: USER_A, workspace_scope: 'product' } as ContextLens,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Context Lens/i);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('rejects a missing query_embedding', async () => {
    const result = await svc.semanticSearch({ query: 'q', lens: lensFor(TENANT_A, USER_A) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/embedding/i);
  });

  it('rejects a query_embedding of the wrong dimensionality', async () => {
    const result = await svc.semanticSearch({
      query: 'q',
      query_embedding: [0.1, 0.2, 0.3],
      lens: lensFor(TENANT_A, USER_A),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1536');
  });

  it('returns "Supabase not configured" when env vars are missing', async () => {
    delete process.env.SUPABASE_URL;
    const result = await svc.semanticSearch({
      query: 'q',
      query_embedding: EMBEDDING_1536,
      lens: lensFor(TENANT_A, USER_A),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Supabase not configured');
  });

  it('surfaces a migration-pending error when the RPC does not exist', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function memory_semantic_search does not exist' } });

    const result = await svc.semanticSearch({
      query: 'q',
      query_embedding: EMBEDDING_1536,
      lens: lensFor(TENANT_A, USER_A),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/migration required/i);
  });

  it('returns ok:false and emits memory.semantic_search.failed on a generic RPC error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });

    const result = await svc.semanticSearch({
      query: 'q',
      query_embedding: EMBEDDING_1536,
      lens: lensFor(TENANT_A, USER_A),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection reset');
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memory.semantic_search.failed', status: 'error' })
    );
  });

  it('maps RPC rows to SemanticSearchResult[] and emits memory.semantic_search.completed', async () => {
    const row = {
      id: 'mem-1',
      content: 'User likes hiking',
      content_json: null,
      category_key: 'preferences',
      source: 'orb_text',
      importance: 60,
      occurred_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      active_role: 'community',
      workspace_scope: 'product',
      visibility_scope: 'private',
      vtid: null,
      origin_service: 'orb-live',
      conversation_id: 'conv-1',
      similarity_score: 0.87,
      recency_score: 0.5,
      combined_score: 0.8,
    };
    mockRpc.mockResolvedValue({ data: [row], error: null });

    const result = await svc.semanticSearch({
      query: 'hobbies',
      query_embedding: EMBEDDING_1536,
      lens: lensFor(TENANT_A, USER_A, { active_role: 'community' }),
    });

    expect(result.ok).toBe(true);
    expect(result.total_found).toBe(1);
    expect(result.results[0]).toMatchObject({ id: 'mem-1', content: 'User likes hiking', similarity_score: 0.87 });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'memory.semantic_search.completed',
        payload: expect.objectContaining({
          results_count: 1,
          lens: expect.objectContaining({ tenant_id: TENANT_A, user_id: USER_A }),
        }),
      })
    );
  });

  it('formats the embedding as a Postgres vector literal and applies request/lens defaults', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await svc.semanticSearch({ query: 'q', query_embedding: EMBEDDING_1536, lens: lensFor(TENANT_A, USER_A) });

    expect(mockRpc).toHaveBeenCalledWith(
      'memory_semantic_search',
      expect.objectContaining({
        p_query_embedding: `[${EMBEDDING_1536.join(',')}]`,
        p_top_k: 10, // default
        p_visibility_scope: 'private', // lens default
        p_recency_boost: true, // request default
      })
    );
  });

  // -----------------------------------------------------------------------
  // Tenant / user isolation (CLAUDE.md §14 ALWAYS #28: scope memory by
  // tenant + role) — the RPC params must carry exactly the calling lens's
  // identity, never a different tenant/user's.
  // -----------------------------------------------------------------------
  it('forwards tenant A / user A identity to the RPC for a tenant-A lens', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await svc.semanticSearch({ query: 'q', query_embedding: EMBEDDING_1536, lens: lensFor(TENANT_A, USER_A) });

    expect(mockRpc).toHaveBeenCalledWith(
      'memory_semantic_search',
      expect.objectContaining({ p_tenant_id: TENANT_A, p_user_id: USER_A })
    );
  });

  it('forwards tenant B / user B identity to the RPC for a tenant-B lens — never tenant A\'s', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await svc.semanticSearch({ query: 'q', query_embedding: EMBEDDING_1536, lens: lensFor(TENANT_B, USER_B) });

    const [, params] = mockRpc.mock.calls[0];
    expect(params.p_tenant_id).toBe(TENANT_B);
    expect(params.p_user_id).toBe(USER_B);
    expect(params.p_tenant_id).not.toBe(TENANT_A);
    expect(params.p_user_id).not.toBe(USER_A);
  });
});

// =============================================================================
// writeMemoryItem()
// =============================================================================

describe('writeMemoryItem()', () => {
  it('rejects an invalid Context Lens', async () => {
    const result = await svc.writeMemoryItem({
      content: 'hi',
      source: 'orb_text',
      lens: { tenant_id: TENANT_A, user_id: '', workspace_scope: 'product' } as ContextLens,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Context Lens/i);
  });

  it('returns "Supabase not configured" when env vars are missing', async () => {
    delete process.env.SUPABASE_URL;
    const result = await svc.writeMemoryItem({ content: 'hi', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Supabase not configured');
  });

  it('writes via memory_write_item_v2, includes the formatted embedding, and emits memory.write.completed on ok', async () => {
    mockRpc.mockResolvedValue({
      data: { ok: true, id: 'mem-1', category_key: 'conversation', workspace_scope: 'product', has_embedding: true },
      error: null,
    });

    const result = await svc.writeMemoryItem({
      content: 'hello',
      source: 'orb_text',
      lens: lensFor(TENANT_A, USER_A),
      embedding: EMBEDDING_1536,
    });

    expect(result.ok).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith(
      'memory_write_item_v2',
      expect.objectContaining({
        p_payload: expect.objectContaining({
          tenant_id: TENANT_A,
          user_id: USER_A,
          embedding: `[${EMBEDDING_1536.join(',')}]`,
          embedding_model: 'text-embedding-3-small',
        }),
      })
    );
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memory.write.completed', status: 'success' })
    );
  });

  it('omits the embedding field when the array has the wrong dimensionality', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, id: 'mem-1' }, error: null });

    await svc.writeMemoryItem({
      content: 'hello',
      source: 'orb_text',
      lens: lensFor(TENANT_A, USER_A),
      embedding: [0.1, 0.2],
    });

    const payload = mockRpc.mock.calls[0][1].p_payload;
    expect(payload.embedding).toBeUndefined();
  });

  it('does not emit memory.write.completed when the RPC reports ok:false', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'validation failed' }, error: null });

    const result = await svc.writeMemoryItem({ content: 'hello', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });

    expect(result.ok).toBe(false);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('falls back to memory_write_item (v1) when v2 does not exist', async () => {
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'memory_write_item_v2') {
        return Promise.resolve({ data: null, error: { message: 'function memory_write_item_v2 does not exist' } });
      }
      if (fn === 'dev_bootstrap_request_context') {
        return Promise.resolve({ data: null, error: null });
      }
      if (fn === 'memory_write_item') {
        return Promise.resolve({ data: { ok: true, id: 'mem-legacy' }, error: null });
      }
      throw new Error(`unexpected rpc ${fn}`);
    });

    const result = await svc.writeMemoryItem({ content: 'hello', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });

    expect(result).toEqual({ ok: true, id: 'mem-legacy' });
    const v1Payload = mockRpc.mock.calls.find((c) => c[0] === 'memory_write_item')![1].p_payload;
    // v1 payload has no tenant/user/embedding columns — those come from
    // the bootstrapped request context, not the RPC payload.
    expect(v1Payload).not.toHaveProperty('embedding');
    expect(v1Payload).not.toHaveProperty('tenant_id');
  });

  it('propagates a generic RPC error (not "does not exist") as ok:false', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    const result = await svc.writeMemoryItem({ content: 'hello', source: 'orb_text', lens: lensFor(TENANT_A, USER_A) });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('permission denied');
  });
});

// =============================================================================
// getItemsNeedingEmbeddings()
// =============================================================================

describe('getItemsNeedingEmbeddings()', () => {
  it('returns "Supabase not configured" when env vars are missing', async () => {
    delete process.env.SUPABASE_URL;
    const result = await svc.getItemsNeedingEmbeddings();
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
  });

  it('applies defaults (limit=100, all filters null) when called with no args', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await svc.getItemsNeedingEmbeddings();

    expect(mockRpc).toHaveBeenCalledWith(
      'memory_get_items_needing_embeddings',
      { p_limit: 100, p_tenant_id: null, p_category_key: null, p_since: null }
    );
  });

  it('maps returned rows to ItemNeedingEmbedding[]', async () => {
    mockRpc.mockResolvedValue({
      data: [{ id: 'i1', content: 'c', category_key: 'health', tenant_id: TENANT_A, user_id: USER_A, created_at: 'now' }],
      error: null,
    });

    const result = await svc.getItemsNeedingEmbeddings(50, { tenant_id: TENANT_A });

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('i1');
    expect(mockRpc).toHaveBeenCalledWith(
      'memory_get_items_needing_embeddings',
      expect.objectContaining({ p_limit: 50, p_tenant_id: TENANT_A })
    );
  });

  it('reports a migration-required error when the RPC does not exist', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function ... does not exist' } });
    const result = await svc.getItemsNeedingEmbeddings();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/migration required/i);
  });
});

// =============================================================================
// updateEmbeddings()
// =============================================================================

describe('updateEmbeddings()', () => {
  it('returns "Supabase not configured" and preserves requested_count when env vars are missing', async () => {
    delete process.env.SUPABASE_URL;
    const result = await svc.updateEmbeddings([{ id: 'i1', embedding: EMBEDDING_1536, embedding_model: 'm' }]);
    expect(result.ok).toBe(false);
    expect(result.requested_count).toBe(1);
    expect(result.updated_count).toBe(0);
  });

  it('formats each embedding into a Postgres vector literal before calling the RPC', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, updated_count: 1, requested_count: 1 }, error: null });

    await svc.updateEmbeddings([{ id: 'i1', embedding: EMBEDDING_1536, embedding_model: 'text-embedding-3-small' }]);

    expect(mockRpc).toHaveBeenCalledWith(
      'memory_update_embeddings',
      { p_updates: [{ id: 'i1', embedding: `[${EMBEDDING_1536.join(',')}]`, embedding_model: 'text-embedding-3-small' }] }
    );
  });

  it('emits memory.embeddings.updated and returns the RPC result on success', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, updated_count: 2, requested_count: 2 }, error: null });

    const result = await svc.updateEmbeddings([
      { id: 'i1', embedding: EMBEDDING_1536, embedding_model: 'm' },
      { id: 'i2', embedding: EMBEDDING_1536, embedding_model: 'm' },
    ]);

    expect(result).toEqual({ ok: true, updated_count: 2, requested_count: 2 });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.embeddings.updated' }));
  });

  it('reports a migration-required error when the RPC does not exist', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function ... does not exist' } });
    const result = await svc.updateEmbeddings([{ id: 'i1', embedding: EMBEDDING_1536, embedding_model: 'm' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/migration required/i);
  });
});

// =============================================================================
// markForReembed()
// =============================================================================

describe('markForReembed()', () => {
  it('returns "Supabase not configured" and preserves the requested filters', async () => {
    delete process.env.SUPABASE_URL;
    const request = { tenant_id: TENANT_A };
    const result = await svc.markForReembed(request);
    expect(result.ok).toBe(false);
    expect(result.filters).toEqual(request);
  });

  it('passes filters through as p_* RPC params, defaulting absent ones to null', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, marked_for_reembed: 3, filters: {} }, error: null });

    await svc.markForReembed({ tenant_id: TENANT_A, category_key: 'health' });

    expect(mockRpc).toHaveBeenCalledWith(
      'memory_mark_for_reembed',
      { p_tenant_id: TENANT_A, p_user_id: null, p_category_key: 'health', p_since: null, p_until: null }
    );
  });

  it('emits memory.reembed.triggered on success', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, marked_for_reembed: 5, filters: {} }, error: null });
    await svc.markForReembed({ tenant_id: TENANT_A });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.reembed.triggered' }));
  });

  it('reports a migration-required error when the RPC does not exist', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function ... does not exist' } });
    const result = await svc.markForReembed({ tenant_id: TENANT_A });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/migration required/i);
  });
});

// =============================================================================
// buildSemanticContext()
// =============================================================================

describe('buildSemanticContext()', () => {
  it('propagates a failed semanticSearch as ok:false with empty context', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const result = await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A));

    expect(result.ok).toBe(false);
    expect(result.context).toBe('');
    expect(result.error).toBe('boom');
  });

  it('returns an empty context string when there are no results', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const result = await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A));

    expect(result.ok).toBe(true);
    expect(result.context).toBe('');
  });

  function row(overrides: Record<string, unknown>) {
    return {
      id: 'mem-x',
      content: 'some memory content',
      content_json: null,
      category_key: 'conversation',
      source: 'orb_text',
      importance: 50,
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      active_role: null,
      workspace_scope: null,
      visibility_scope: null,
      vtid: null,
      origin_service: null,
      conversation_id: null,
      similarity_score: 0.5,
      recency_score: 0.5,
      combined_score: 0.5,
      ...overrides,
    };
  }

  it('groups results by category and orders categories by priority (health before conversation)', async () => {
    mockRpc.mockResolvedValue({
      data: [
        row({ id: 'c1', category_key: 'conversation', content: 'chit chat' }),
        row({ id: 'h1', category_key: 'health', content: 'blood pressure normal' }),
      ],
      error: null,
    });

    const result = await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A));

    const healthIdx = result.context.indexOf('Health & Wellness');
    const convoIdx = result.context.indexOf('Recent Conversations');
    expect(healthIdx).toBeGreaterThanOrEqual(0);
    expect(convoIdx).toBeGreaterThanOrEqual(0);
    expect(healthIdx).toBeLessThan(convoIdx);
  });

  it('marks high-similarity results with "*" and low-similarity results with "-"', async () => {
    mockRpc.mockResolvedValue({
      data: [
        row({ id: 'strong', category_key: 'goals', content: 'run a marathon', similarity_score: 0.95 }),
        row({ id: 'weak', category_key: 'goals', content: 'maybe read more', similarity_score: 0.3 }),
      ],
      error: null,
    });

    const result = await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A));

    expect(result.context).toMatch(/\* \[.*\] run a marathon/);
    expect(result.context).toMatch(/- \[.*\] maybe read more/);
  });

  it('truncates content longer than 300 characters with an ellipsis', async () => {
    const longContent = 'x'.repeat(400);
    mockRpc.mockResolvedValue({ data: [row({ category_key: 'notes', content: longContent })], error: null });

    const result = await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A));

    expect(result.context).toContain('x'.repeat(297) + '...');
    expect(result.context).not.toContain(longContent);
  });

  it('formats a very recent occurred_at as "just now"', async () => {
    mockRpc.mockResolvedValue({
      data: [row({ category_key: 'notes', content: 'fresh note', occurred_at: new Date().toISOString() })],
      error: null,
    });

    const result = await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A));
    expect(result.context).toContain('just now');
  });

  it('formats a several-days-old occurred_at as "Nd ago"', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    mockRpc.mockResolvedValue({
      data: [row({ category_key: 'notes', content: 'old note', occurred_at: threeDaysAgo })],
      error: null,
    });

    const result = await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A));
    expect(result.context).toContain('3d ago');
  });

  it('forwards the caller-provided topK as the search top_k', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await svc.buildSemanticContext('q', EMBEDDING_1536, lensFor(TENANT_A, USER_A), 3);

    expect(mockRpc).toHaveBeenCalledWith('memory_semantic_search', expect.objectContaining({ p_top_k: 3 }));
  });
});

// =============================================================================
// createServiceClient() + exported constants
// =============================================================================

describe('createServiceClient()', () => {
  it('returns null when SUPABASE_URL is missing', () => {
    delete process.env.SUPABASE_URL;
    expect(svc.createServiceClient()).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns null when both service-role env vars are missing', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE;
    expect(svc.createServiceClient()).toBeNull();
  });

  it('accepts SUPABASE_SERVICE_ROLE as a fallback for SUPABASE_SERVICE_ROLE_KEY', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE = 'fallback-key';

    const client = svc.createServiceClient();

    expect(client).not.toBeNull();
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://proj.supabase.co',
      'fallback-key',
      expect.objectContaining({ auth: expect.objectContaining({ autoRefreshToken: false, persistSession: false }) })
    );
  });

  it('constructs a client with autoRefreshToken/persistSession disabled when configured', () => {
    const client = svc.createServiceClient();
    expect(client).not.toBeNull();
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://proj.supabase.co',
      'service-role-key',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  });
});

describe('exported constants', () => {
  it('match the documented pgvector / embedding-model contract', () => {
    expect(svc.VTID).toBe('VTID-01184');
    expect(svc.SERVICE_NAME).toBe('supabase-semantic-memory');
    expect(svc.EMBEDDING_DIMENSIONS).toBe(1536);
    expect(svc.DEFAULT_EMBEDDING_MODEL).toBe('text-embedding-3-small');
  });
});
