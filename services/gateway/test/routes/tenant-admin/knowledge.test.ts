/**
 * Tests for src/routes/tenant-admin/knowledge.ts
 *
 * Mounted in prod at /api/v1/admin/tenants/:tenantId/kb
 *   GET/POST /documents, GET/PUT/DELETE /documents/:id,
 *   POST/DELETE /baseline/:documentId/optout, GET /search, GET /topics
 *
 * Guarded by requireTenantAdmin. Tenant docs live in kb_documents with
 * tenant_id set; baseline docs have tenant_id NULL and per-tenant opt-outs
 * in tenant_kb_baseline_optouts.
 */
import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    upsert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    or: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: (v: any) => any) => {
      const value = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(value).then(resolve);
    }),
    mockResolvedValue(v: any) {
      defaultData = v;
      return chain;
    },
    mockResolvedValueOnce(v: any) {
      responseQueue.push(v);
      return chain;
    },
    mockReset() {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const tableChains: Record<string, ReturnType<typeof createChain>> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain());

const mockSupabase = { from: jest.fn((table: string) => chainFor(table)) };
const mockGetSupabase = jest.fn(() => mockSupabase as any);

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

jest.mock('jose');

const mockUserTenantsSingle = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: mockUserTenantsSingle,
          })),
        })),
      })),
    })),
  })),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../../src/routes/tenant-admin/knowledge').default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/tenants/:tenantId/kb', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOC_ID = '77777777-7777-4777-8777-777777777777';

const tenantAdminClaims = (tenantId: string) => ({
  sub: 'admin-a',
  email: 'admin-a@example.com',
  app_metadata: { active_tenant_id: tenantId, exafy_admin: false },
});

function mockVerifiedJwt(payload: object) {
  (jose.jwtVerify as jest.Mock).mockResolvedValue({ payload });
}

function mockInvalidJwt() {
  (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('signature verification failed'));
}

describe('Tenant Admin Knowledge Base Routes', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret';
    delete process.env.SUPABASE_AUTH_JWKS_URL;
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockUserTenantsSingle.mockResolvedValue({ data: { active_role: 'admin' }, error: null });
    mockInvalidJwt();
  });

  // --- Auth / RBAC ---

  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get(`/api/v1/admin/tenants/${TENANT_A}/kb/documents`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('tenant isolation: tenant A admin cannot delete a tenant B document (403, no delete)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .delete(`/api/v1/admin/tenants/${TENANT_B}/kb/documents/${DOC_ID}`)
      .set('Authorization', 'Bearer tenant-a-token');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(chainFor('kb_documents').delete).not.toHaveBeenCalled();
  });

  it('returns 503 when the DB client is unavailable', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    mockGetSupabase.mockReturnValue(null as any);

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kb/documents`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DB_UNAVAILABLE');
  });

  // --- GET /documents ---

  it('GET /documents merges tenant + baseline docs and flags opt-outs', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_kb_baseline_optouts').mockResolvedValueOnce({
      data: [{ document_id: 'base-2' }],
      error: null,
    });
    chainFor('kb_documents').mockResolvedValueOnce({
      data: [
        { id: 'doc-1', tenant_id: TENANT_A, title: 'Tenant doc' },
        { id: 'base-1', tenant_id: null, title: 'Baseline kept' },
        { id: 'base-2', tenant_id: null, title: 'Baseline opted out' },
      ],
      error: null,
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kb/documents`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.documents.map((d: any) => [d.id, d]));
    expect(byId['doc-1']).toMatchObject({ is_baseline: false, is_opted_out: false });
    expect(byId['base-1']).toMatchObject({ is_baseline: true, is_opted_out: false });
    expect(byId['base-2']).toMatchObject({ is_baseline: true, is_opted_out: true });

    // Tenant isolation: only this tenant's docs (or global baseline) are queried
    expect(chainFor('kb_documents').or).toHaveBeenCalledWith(
      `tenant_id.eq.${TENANT_A},tenant_id.is.null`
    );
    expect(chainFor('tenant_kb_baseline_optouts').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('GET /documents?source=tenant restricts to this tenant only', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('tenant_kb_baseline_optouts').mockResolvedValueOnce({ data: [], error: null });
    chainFor('kb_documents').mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kb/documents?source=tenant`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(chainFor('kb_documents').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  // --- POST /documents ---

  it('POST /documents requires a title', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/kb/documents`)
      .set('Authorization', 'Bearer token')
      .send({ body: 'text with no title' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TITLE_REQUIRED');
    expect(chainFor('kb_documents').insert).not.toHaveBeenCalled();
  });

  it('POST /documents inserts into the caller\'s tenant with pending status and creator', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const created = { id: DOC_ID, tenant_id: TENANT_A, title: 'Guide', status: 'pending' };
    chainFor('kb_documents').mockResolvedValueOnce({ data: created, error: null });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/kb/documents`)
      .set('Authorization', 'Bearer token')
      .send({ title: 'Guide', body: 'Content', topics: ['health'] });

    expect(res.status).toBe(201);
    expect(res.body.document).toEqual(created);
    expect(chainFor('kb_documents').insert).toHaveBeenCalledWith({
      tenant_id: TENANT_A, // doc is bound to this tenant — no cross-tenant writes
      title: 'Guide',
      body: 'Content',
      source: 'upload',
      topics: ['health'],
      visibility: {},
      status: 'pending',
      created_by: 'admin-a',
    });
  });

  // --- GET /documents/:id ---

  it('GET /documents/:id scopes lookup to tenant-or-baseline and 404s otherwise', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('kb_documents');
    // Another tenant's doc → scoped query finds nothing
    chain.mockResolvedValueOnce({ data: null, error: { message: 'No rows' } });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kb/documents/${DOC_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(chain.or).toHaveBeenCalledWith(`tenant_id.eq.${TENANT_A},tenant_id.is.null`);
    expect(chain.eq).toHaveBeenCalledWith('id', DOC_ID);
  });

  // --- PUT /documents/:id ---

  it('PUT /documents/:id updates only own-tenant docs (baseline/foreign → 404)', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('kb_documents');
    // update matched 0 rows (baseline doc or another tenant's doc)
    chain.mockResolvedValueOnce({ data: null, error: { message: 'No rows' } });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/kb/documents/${DOC_ID}`)
      .set('Authorization', 'Bearer token')
      .send({ title: 'Hijack attempt' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND_OR_BASELINE');
    // The mutation itself carries the tenant filter — this is the isolation gate
    expect(chain.eq).toHaveBeenCalledWith('id', DOC_ID);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('PUT /documents/:id applies only the provided fields', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('kb_documents');
    const updated = { id: DOC_ID, tenant_id: TENANT_A, title: 'New title' };
    chain.mockResolvedValueOnce({ data: updated, error: null });

    const res = await request(app)
      .put(`/api/v1/admin/tenants/${TENANT_A}/kb/documents/${DOC_ID}`)
      .set('Authorization', 'Bearer token')
      .send({ title: 'New title', status: 'indexed' });

    expect(res.status).toBe(200);
    expect(res.body.document).toEqual(updated);
    const updateArg = (chain.update as jest.Mock).mock.calls[0][0];
    expect(updateArg).toMatchObject({ title: 'New title', status: 'indexed', updated_at: expect.any(String) });
    expect(updateArg.body).toBeUndefined();
    expect(updateArg.topics).toBeUndefined();
  });

  // --- DELETE /documents/:id ---

  it('DELETE /documents/:id deletes with the tenant filter applied', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('kb_documents');
    chain.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .delete(`/api/v1/admin/tenants/${TENANT_A}/kb/documents/${DOC_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('id', DOC_ID);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A); // can't delete other tenants' docs
  });

  it('DELETE /documents/:id returns 500 on DB error', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    chainFor('kb_documents').mockResolvedValueOnce({ data: null, error: { message: 'delete failed' } });

    const res = await request(app)
      .delete(`/api/v1/admin/tenants/${TENANT_A}/kb/documents/${DOC_ID}`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('delete failed');
  });

  // --- Baseline opt-out ---

  it('POST /baseline/:documentId/optout upserts a tenant-scoped opt-out', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_kb_baseline_optouts');
    chain.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post(`/api/v1/admin/tenants/${TENANT_A}/kb/baseline/${DOC_ID}/optout`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(chain.upsert).toHaveBeenCalledWith(
      { tenant_id: TENANT_A, document_id: DOC_ID, opted_out_by: 'admin-a' },
      { onConflict: 'tenant_id,document_id' }
    );
  });

  it('DELETE /baseline/:documentId/optout removes only this tenant\'s opt-out row', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('tenant_kb_baseline_optouts');
    chain.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .delete(`/api/v1/admin/tenants/${TENANT_A}/kb/baseline/${DOC_ID}/optout`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chain.eq).toHaveBeenCalledWith('document_id', DOC_ID);
  });

  // --- GET /search ---

  it('GET /search requires a query string', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kb/search`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('QUERY_REQUIRED');
  });

  it('GET /search ranks tenant docs high, baseline low, and drops opted-out baseline docs', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const kbChain = chainFor('kb_documents');
    // 1) tenant docs, 2) baseline docs (sequential awaits on same table)
    kbChain.mockResolvedValueOnce({
      data: [{ id: 't1', title: 'Sleep tips (tenant)', topics: [], status: 'indexed' }],
      error: null,
    });
    kbChain.mockResolvedValueOnce({
      data: [
        { id: 'b1', title: 'Sleep basics', topics: [], status: 'indexed' },
        { id: 'b2', title: 'Sleep advanced', topics: [], status: 'indexed' },
      ],
      error: null,
    });
    chainFor('tenant_kb_baseline_optouts').mockResolvedValueOnce({
      data: [{ document_id: 'b2' }],
      error: null,
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kb/search?q=sleep`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.id)).toEqual(['t1', 'b1']);
    expect(res.body.results[0]).toMatchObject({ source: 'tenant', rank: 'high' });
    expect(res.body.results[1]).toMatchObject({ source: 'baseline', rank: 'low' });

    // Tenant-doc leg was tenant-filtered; baseline leg looked for NULL tenant
    expect(kbChain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(kbChain.is).toHaveBeenCalledWith('tenant_id', null);
    expect(kbChain.ilike).toHaveBeenCalledWith('title', '%sleep%');
  });

  // --- GET /topics ---

  it('GET /topics returns sorted distinct topics from this tenant\'s docs only', async () => {
    mockVerifiedJwt(tenantAdminClaims(TENANT_A));
    const chain = chainFor('kb_documents');
    chain.mockResolvedValueOnce({
      data: [
        { topics: ['nutrition', 'sleep'] },
        { topics: ['sleep', 'exercise'] },
        { topics: null },
      ],
      error: null,
    });

    const res = await request(app)
      .get(`/api/v1/admin/tenants/${TENANT_A}/kb/topics`)
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.topics).toEqual(['exercise', 'nutrition', 'sleep']);
    expect(chain.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });
});
