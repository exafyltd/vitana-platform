/**
 * VTID-04279 — approvals.ts requires a real, verified exafy_admin session.
 *
 * Before this VTID, every route on this router (including the write routes
 * — POST /:approval_id/approve calls the internal autonomous-pr-merge
 * endpoint with automerge:true) had NO auth at all. Any caller who could
 * guess/enumerate a VTID number could merge its PR. Fix: router.use
 * (requireAdminAuth), the same pattern admin-navigator.ts / feedback-
 * admin.ts / specialists-admin.ts already use.
 *
 * buildApp() calls jest.resetModules() so the route gets a fresh copy of
 * the mocked middleware each test — same pattern
 * test/routes/admin-feature-flags.test.ts already established for pinning
 * requireAdminAuth wiring.
 */
import request from 'supertest';
import express from 'express';

const mockAdminGuard: { impl: (req: any, res: any, next: any) => void } = {
  impl: (_req, res, _next) => {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', message: 'Missing or invalid Authorization header. Expected: Bearer <token>' });
  },
};

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => mockAdminGuard.impl(req, res, next),
}));

const mockService = {
  getPendingApprovalCount: jest.fn(),
  getPendingApprovals: jest.fn(),
  approveApprovalById: jest.fn(),
  rejectApprovalById: jest.fn(),
  emitApprovalDecision: jest.fn(),
};

jest.mock('../../src/services/approvals-service', () => ({
  getPendingApprovalCount: (...args: any[]) => mockService.getPendingApprovalCount(...args),
  getPendingApprovals: (...args: any[]) => mockService.getPendingApprovals(...args),
  approveApprovalById: (...args: any[]) => mockService.approveApprovalById(...args),
  rejectApprovalById: (...args: any[]) => mockService.rejectApprovalById(...args),
  emitApprovalDecision: (...args: any[]) => mockService.emitApprovalDecision(...args),
}));

jest.mock('../../src/services/github-service', () => ({
  listOpenPrsWithStatus: jest.fn(async () => []),
}));

function buildApp() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/approvals').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/approvals', router);
  return app;
}

describe('approvals router — auth gate (VTID-04279)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminGuard.impl = (_req: any, res: any, _next: any) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', message: 'Missing or invalid Authorization header. Expected: Bearer <token>' });
    };
  });

  const writeRoutes: Array<[string, string]> = [
    ['post', '/api/v1/approvals/feed/approve'],
    ['post', '/api/v1/approvals/appr_VTID-01234_abcdef/approve'],
    ['post', '/api/v1/approvals/appr_VTID-01234_abcdef/reject'],
  ];
  const readRoutes: Array<[string, string]> = [
    ['get', '/api/v1/approvals/count'],
    ['get', '/api/v1/approvals/pending'],
    ['get', '/api/v1/approvals/feed'],
  ];

  it.each([...readRoutes, ...writeRoutes])('rejects %s %s with 401 when unauthenticated, before any service call', async (method, path) => {
    const app = buildApp();
    const res = await (request(app) as any)[method](path);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(mockService.getPendingApprovalCount).not.toHaveBeenCalled();
    expect(mockService.getPendingApprovals).not.toHaveBeenCalled();
    expect(mockService.approveApprovalById).not.toHaveBeenCalled();
    expect(mockService.rejectApprovalById).not.toHaveBeenCalled();
  });

  it('rejects a non-exafy_admin caller with 403 (requireAdminAuth is a real gate, not just "any token")', async () => {
    mockAdminGuard.impl = (_req: any, res: any, _next: any) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'This endpoint requires exafy_admin privileges' });
    };
    const app = buildApp();
    const res = await request(app).get('/api/v1/approvals/count');
    expect(res.status).toBe(403);
    expect(mockService.getPendingApprovalCount).not.toHaveBeenCalled();
  });

  it('a verified exafy_admin caller reaches GET /count and gets the service result', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-1', exafy_admin: true };
      next();
    };
    mockService.getPendingApprovalCount.mockResolvedValue({ status: 200, body: { ok: true, pending_count: 3 } });
    const app = buildApp();
    const res = await request(app).get('/api/v1/approvals/count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, pending_count: 3 });
    expect(mockService.getPendingApprovalCount).toHaveBeenCalledTimes(1);
  });

  it('a verified exafy_admin caller reaches GET /pending, honoring the limit query param', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-1', exafy_admin: true };
      next();
    };
    mockService.getPendingApprovals.mockResolvedValue({ status: 200, body: { ok: true, items: [] } });
    const app = buildApp();
    const res = await request(app).get('/api/v1/approvals/pending?limit=7');
    expect(res.status).toBe(200);
    expect(mockService.getPendingApprovals).toHaveBeenCalledWith(7);
  });

  it('a verified exafy_admin caller reaches POST /:approval_id/approve and their user_id is forwarded as the decider', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-42', exafy_admin: true };
      next();
    };
    mockService.approveApprovalById.mockResolvedValue({ status: 200, body: { ok: true, result: { merged: true } } });
    const app = buildApp();
    const res = await request(app).post('/api/v1/approvals/appr_VTID-01234_abcdef/approve');
    expect(res.status).toBe(200);
    expect(mockService.approveApprovalById).toHaveBeenCalledWith('appr_VTID-01234_abcdef', 'admin-42');
  });

  it('a verified exafy_admin caller reaches POST /:approval_id/reject with the reason and their user_id', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-42', exafy_admin: true };
      next();
    };
    mockService.rejectApprovalById.mockResolvedValue({ status: 200, body: { ok: true } });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/approvals/appr_VTID-01234_abcdef/reject')
      .send({ reason: 'not ready' });
    expect(res.status).toBe(200);
    expect(mockService.rejectApprovalById).toHaveBeenCalledWith('appr_VTID-01234_abcdef', 'not ready', 'admin-42');
  });

  it('propagates the service function status code verbatim (e.g. 404 VTID not found)', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-1', exafy_admin: true };
      next();
    };
    mockService.approveApprovalById.mockResolvedValue({
      status: 404,
      body: { ok: false, error: 'VTID VTID-01234 not found in ledger' },
    });
    const app = buildApp();
    const res = await request(app).post('/api/v1/approvals/appr_VTID-01234_abcdef/approve');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

describe('approvals router — source wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/routes/approvals.ts'),
    'utf8'
  );

  it('mounts requireAdminAuth on the whole router, before any route definition', () => {
    expect(source).toMatch(/import \{ requireAdminAuth, AuthenticatedRequest \} from '\.\.\/middleware\/auth-supabase-jwt'/);
    const useIdx = source.indexOf('router.use(requireAdminAuth)');
    const firstRouteIdx = source.indexOf("router.get('/count'");
    expect(useIdx).toBeGreaterThan(-1);
    expect(firstRouteIdx).toBeGreaterThan(-1);
    expect(useIdx).toBeLessThan(firstRouteIdx);
  });

  it('the write routes pass the verified identity, not a client-suppliable field, as the decider', () => {
    expect(source).toMatch(/identity\?\.user_id \?\? null/);
    expect(source).not.toMatch(/req\.body\.(user_id|decided_by|approved_by)/);
  });
});
