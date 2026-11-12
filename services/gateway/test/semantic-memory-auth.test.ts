/**
 * Plan gateway-critical-route-auth, lane semantic-memory-auth (VTID-05729).
 *
 * Pins the auth gates on src/routes/semantic-memory.ts:
 *   1. POST /semantic/search, /semantic/write, /semantic/context run behind
 *      requireAuthWithTenant: no token → 401.
 *   2. The lens tenant_id/user_id are the caller's (req.identity). A body lens
 *      naming another tenant or user → 403 LENS_MISMATCH and no service call.
 *      exafy_admin gets no override.
 *   3. With no body lens, the service is called with the identity's ids.
 *   4. POST /admin/embeddings/generate, /reembed and GET /admin/embeddings/status
 *      run behind requireAdminAuth: no token → 401, non-admin → 403, admin →
 *      handler runs.
 *
 * The auth middleware is mocked per test token so the gates are exercised
 * without JWT verification or Supabase lookups.
 */

import express from 'express';
import request from 'supertest';

const TENANT_T = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

// --- auth middleware mock: 'user-a' → A in T; 'admin' → exafy_admin; else 401
jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const identities: Record<string, any> = {
    'user-a': {
      user_id: '22222222-2222-4222-8222-222222222222',
      tenant_id: '11111111-1111-4111-8111-111111111111',
      exafy_admin: false,
    },
    admin: {
      user_id: '55555555-5555-4555-8555-555555555555',
      tenant_id: '11111111-1111-4111-8111-111111111111',
      exafy_admin: true,
    },
  };
  const identify = (req: any) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    return identities[token] ? { ...identities[token] } : null;
  };
  return {
    requireAuthWithTenant: (req: any, res: any, next: () => void) => {
      const identity = identify(req);
      if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = identity;
      next();
    },
    requireAdminAuth: (req: any, res: any, next: () => void) => {
      const identity = identify(req);
      if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = identity;
      if (!identity.exafy_admin) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      next();
    },
  };
});

const mockSemanticSearch = jest.fn();
const mockWriteMemoryItem = jest.fn();
const mockBuildSemanticContext = jest.fn();
const mockGetItemsNeedingEmbeddings = jest.fn();
const mockUpdateEmbeddings = jest.fn();
const mockMarkForReembed = jest.fn();
jest.mock('../src/services/supabase-semantic-memory', () => ({
  semanticSearch: (...a: unknown[]) => mockSemanticSearch(...a),
  writeMemoryItem: (...a: unknown[]) => mockWriteMemoryItem(...a),
  buildSemanticContext: (...a: unknown[]) => mockBuildSemanticContext(...a),
  getItemsNeedingEmbeddings: (...a: unknown[]) => mockGetItemsNeedingEmbeddings(...a),
  updateEmbeddings: (...a: unknown[]) => mockUpdateEmbeddings(...a),
  markForReembed: (...a: unknown[]) => mockMarkForReembed(...a),
  VTID: 'VTID-01184',
  EMBEDDING_DIMENSIONS: 1024,
}));

const mockGenerateEmbedding = jest.fn();
const mockGenerateBatchEmbeddings = jest.fn();
jest.mock('../src/services/memory-embedding', () => ({
  generateMemoryEmbedding: (...a: unknown[]) => mockGenerateEmbedding(...a),
  generateMemoryBatchEmbeddings: (...a: unknown[]) => mockGenerateBatchEmbeddings(...a),
  isMemoryEmbeddingAvailable: () => ({ available: true }),
}));

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));

import router from '../src/routes/semantic-memory';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/memory', router);
  return app;
}

const EMBEDDING = Array.from({ length: 1024 }, () => 0.01);
const BASE = '/api/v1/memory';

const bodies: Record<string, Record<string, unknown>> = {
  '/semantic/search': { query: 'hello' },
  '/semantic/write': { content: 'the user really likes hiking', source: 'orb_text' },
  '/semantic/context': { query: 'sleep tips' },
};
const userRoutes = Object.keys(bodies);
const adminRoutes = ['/admin/embeddings/generate', '/admin/embeddings/reembed'];

const serviceFor: Record<string, jest.Mock> = {
  '/semantic/search': mockSemanticSearch,
  '/semantic/write': mockWriteMemoryItem,
  '/semantic/context': mockBuildSemanticContext,
};
// lens is the 1st arg's .lens for search/write, the 3rd positional arg for context
const lensOf = (route: string): any => {
  const call = serviceFor[route].mock.calls[0];
  return route === '/semantic/context' ? call[2] : call[0].lens;
};

const allServiceMocks = () => [
  mockSemanticSearch,
  mockWriteMemoryItem,
  mockBuildSemanticContext,
  mockGetItemsNeedingEmbeddings,
  mockUpdateEmbeddings,
  mockMarkForReembed,
  mockGenerateEmbedding,
  mockGenerateBatchEmbeddings,
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateEmbedding.mockResolvedValue({ ok: true, embedding: EMBEDDING, model: 'titan' });
  mockSemanticSearch.mockResolvedValue({ ok: true, results: [], query: 'hello', total_found: 0 });
  mockWriteMemoryItem.mockResolvedValue({ ok: true, id: 'mem-1' });
  mockBuildSemanticContext.mockResolvedValue({ ok: true, context: '', results: [] });
  mockGetItemsNeedingEmbeddings.mockResolvedValue({ ok: true, items: [] });
  mockMarkForReembed.mockResolvedValue({ ok: true, marked_count: 0 });
});

describe('semantic-memory: no token → 401 on every write route', () => {
  it.each([...userRoutes, ...adminRoutes])('POST %s without Authorization → 401, no service call', async (route) => {
    const body = bodies[route] ?? {};
    const res = await request(buildApp())
      .post(BASE + route)
      .send({ ...body, lens: { tenant_id: TENANT_T, user_id: USER_A, workspace_scope: 'product' } });
    expect(res.status).toBe(401);
    for (const m of allServiceMocks()) expect(m).not.toHaveBeenCalled();
  });
});

describe('semantic-memory: body lens naming another user/tenant → 403 LENS_MISMATCH', () => {
  it.each(userRoutes)('POST %s with lens.user_id = B → 403, no service call', async (route) => {
    const res = await request(buildApp())
      .post(BASE + route)
      .set('Authorization', 'Bearer user-a')
      .send({ ...bodies[route], lens: { tenant_id: TENANT_T, user_id: USER_B, workspace_scope: 'product' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'LENS_MISMATCH' });
    expect(mockSemanticSearch).not.toHaveBeenCalled();
    expect(mockWriteMemoryItem).not.toHaveBeenCalled();
    expect(mockBuildSemanticContext).not.toHaveBeenCalled();
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it.each(userRoutes)('POST %s with lens.tenant_id = another tenant → 403, no service call', async (route) => {
    const res = await request(buildApp())
      .post(BASE + route)
      .set('Authorization', 'Bearer user-a')
      .send({ ...bodies[route], lens: { tenant_id: TENANT_B, user_id: USER_A, workspace_scope: 'product' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'LENS_MISMATCH' });
    expect(serviceFor[route]).not.toHaveBeenCalled();
  });

  it.each(userRoutes)('POST %s as exafy_admin with lens.user_id = B → 403 (no admin override)', async (route) => {
    const res = await request(buildApp())
      .post(BASE + route)
      .set('Authorization', 'Bearer admin')
      .send({ ...bodies[route], lens: { tenant_id: TENANT_T, user_id: USER_B, workspace_scope: 'product' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'LENS_MISMATCH' });
    expect(serviceFor[route]).not.toHaveBeenCalled();
  });
});

describe('semantic-memory: lens ids come from the identity', () => {
  it.each(userRoutes)('POST %s with no body lens → service called with tenant T, user A, scope product', async (route) => {
    const res = await request(buildApp())
      .post(BASE + route)
      .set('Authorization', 'Bearer user-a')
      .send(bodies[route]);
    expect(res.status).toBeLessThan(300);
    expect(serviceFor[route]).toHaveBeenCalledTimes(1);
    expect(lensOf(route)).toMatchObject({ tenant_id: TENANT_T, user_id: USER_A, workspace_scope: 'product' });
  });

  it.each(userRoutes)('POST %s with own ids and extra lens fields → ids kept, extra fields forwarded', async (route) => {
    const res = await request(buildApp())
      .post(BASE + route)
      .set('Authorization', 'Bearer user-a')
      .send({
        ...bodies[route],
        lens: {
          tenant_id: TENANT_T,
          user_id: USER_A,
          workspace_scope: 'dev',
          active_role: 'patient',
          allowed_categories: ['health'],
        },
      });
    expect(res.status).toBeLessThan(300);
    expect(lensOf(route)).toMatchObject({
      tenant_id: TENANT_T,
      user_id: USER_A,
      workspace_scope: 'dev',
      active_role: 'patient',
      allowed_categories: ['health'],
    });
  });

  it.each(userRoutes)('POST %s with a lens without ids → ids filled from the identity', async (route) => {
    const res = await request(buildApp())
      .post(BASE + route)
      .set('Authorization', 'Bearer user-a')
      .send({ ...bodies[route], lens: { active_role: 'patient' } });
    expect(res.status).toBeLessThan(300);
    expect(lensOf(route)).toMatchObject({
      tenant_id: TENANT_T,
      user_id: USER_A,
      workspace_scope: 'product',
      active_role: 'patient',
    });
  });
});

describe('semantic-memory: admin embedding routes require exafy_admin', () => {
  it.each(adminRoutes)('POST %s as a non-admin → 403, no service call', async (route) => {
    const res = await request(buildApp())
      .post(BASE + route)
      .set('Authorization', 'Bearer user-a')
      .send({});
    expect(res.status).toBe(403);
    expect(mockGetItemsNeedingEmbeddings).not.toHaveBeenCalled();
    expect(mockMarkForReembed).not.toHaveBeenCalled();
  });

  it('POST /admin/embeddings/generate as admin → handler runs', async () => {
    const res = await request(buildApp())
      .post(BASE + '/admin/embeddings/generate')
      .set('Authorization', 'Bearer admin')
      .send({ limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockGetItemsNeedingEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('GET /admin/embeddings/status without Authorization → 401, no service call', async () => {
    const res = await request(buildApp()).get(BASE + '/admin/embeddings/status');
    expect(res.status).toBe(401);
    expect(mockGetItemsNeedingEmbeddings).not.toHaveBeenCalled();
  });

  it('GET /admin/embeddings/status as a non-admin → 403, no service call', async () => {
    const res = await request(buildApp())
      .get(BASE + '/admin/embeddings/status')
      .set('Authorization', 'Bearer user-a');
    expect(res.status).toBe(403);
    expect(mockGetItemsNeedingEmbeddings).not.toHaveBeenCalled();
  });

  it('GET /admin/embeddings/status as admin → handler runs', async () => {
    const res = await request(buildApp())
      .get(BASE + '/admin/embeddings/status')
      .set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockGetItemsNeedingEmbeddings).toHaveBeenCalledWith(1);
  });

  it('POST /admin/embeddings/reembed as admin → handler runs', async () => {
    const res = await request(buildApp())
      .post(BASE + '/admin/embeddings/reembed')
      .set('Authorization', 'Bearer admin')
      .send({ user_id: USER_B });
    expect(res.status).toBe(200);
    expect(mockMarkForReembed).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER_B }));
  });
});
