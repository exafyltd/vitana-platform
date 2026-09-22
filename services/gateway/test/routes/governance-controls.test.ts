/**
 * VTID-04279 — governance-controls.ts requires a real, verified exafy_admin
 * session.
 *
 * Before this VTID, POST /api/v1/governance/controls/:key (arms/disarms
 * system kill-switches like EXECUTION_DISARMED, AUTOPILOT_LOOP_ENABLED)
 * trusted caller-supplied x-user-id/x-user-role headers with zero
 * signature verification — `x-user-role: admin` on any request was
 * sufficient. Fix: router.use(requireAdminAuth), the same pattern
 * admin-navigator.ts / feedback-admin.ts / specialists-admin.ts already
 * use, plus deriving the audit-trail actor from the verified identity
 * (req.identity) instead of from those same spoofable headers.
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
  getAllSystemControls: jest.fn(),
  getSystemControl: jest.fn(),
  updateSystemControl: jest.fn(),
  getControlAuditHistory: jest.fn(),
};

jest.mock('../../src/services/system-controls-service', () => ({
  getAllSystemControls: (...args: any[]) => mockService.getAllSystemControls(...args),
  getSystemControl: (...args: any[]) => mockService.getSystemControl(...args),
  updateSystemControl: (...args: any[]) => mockService.updateSystemControl(...args),
  getControlAuditHistory: (...args: any[]) => mockService.getControlAuditHistory(...args),
}));

function buildApp() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/governance-controls').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/governance/controls', router);
  return app;
}

describe('governance-controls router — auth gate (VTID-04279)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminGuard.impl = (_req: any, res: any, _next: any) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', message: 'Missing or invalid Authorization header. Expected: Bearer <token>' });
    };
  });

  it('rejects GET / with 401 when unauthenticated', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/governance/controls');
    expect(res.status).toBe(401);
    expect(mockService.getAllSystemControls).not.toHaveBeenCalled();
  });

  it('rejects GET /:key with 401 when unauthenticated', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/governance/controls/EXECUTION_DISARMED');
    expect(res.status).toBe(401);
    expect(mockService.getSystemControl).not.toHaveBeenCalled();
  });

  it('rejects POST /:key with 401, before any control is touched — the actual kill-switch gate', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/governance/controls/EXECUTION_DISARMED')
      .send({ enabled: true, reason: 'attacker-supplied' });
    expect(res.status).toBe(401);
    expect(mockService.updateSystemControl).not.toHaveBeenCalled();
  });

  it('a spoofed x-user-role header alone no longer grants write access — the exact pre-fix bypass', async () => {
    // requireAdminAuth is mocked to reject unless a verified req.identity
    // was set — this proves the header alone, with no valid Bearer JWT
    // behind it, cannot reach updateSystemControl any more.
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/governance/controls/EXECUTION_DISARMED')
      .set('x-user-role', 'admin')
      .set('x-user-id', 'attacker')
      .send({ enabled: false, reason: 'spoofed' });
    expect(res.status).toBe(401);
    expect(mockService.updateSystemControl).not.toHaveBeenCalled();
  });

  it('rejects a non-exafy_admin caller with 403', async () => {
    mockAdminGuard.impl = (_req: any, res: any, _next: any) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'This endpoint requires exafy_admin privileges' });
    };
    const app = buildApp();
    const res = await request(app).get('/api/v1/governance/controls');
    expect(res.status).toBe(403);
    expect(mockService.getAllSystemControls).not.toHaveBeenCalled();
  });

  it('a verified exafy_admin caller reaches GET / and lists controls', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-1', exafy_admin: true };
      next();
    };
    mockService.getAllSystemControls.mockResolvedValue([{ key: 'EXECUTION_DISARMED', enabled: false }]);
    const app = buildApp();
    const res = await request(app).get('/api/v1/governance/controls');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [{ key: 'EXECUTION_DISARMED', enabled: false }] });
  });

  it('a verified exafy_admin caller can update a control, and the audit trail records their VERIFIED identity, not a client-suppliable header', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'real-admin-99', exafy_admin: true };
      next();
    };
    mockService.updateSystemControl.mockResolvedValue({ ok: true, control: { key: 'AUTOPILOT_LOOP_ENABLED', enabled: true }, audit_id: 'a-1' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/governance/controls/AUTOPILOT_LOOP_ENABLED')
      // an attacker-controlled x-user-id header, sent alongside a real,
      // verified admin session — must NOT override the verified actor.
      .set('x-user-id', 'someone-else')
      .send({ enabled: true, reason: 'testing' });

    expect(res.status).toBe(200);
    expect(mockService.updateSystemControl).toHaveBeenCalledWith(
      'AUTOPILOT_LOOP_ENABLED',
      expect.objectContaining({
        enabled: true,
        reason: 'testing',
        updated_by: 'real-admin-99',
        updated_by_role: 'exafy_admin',
      })
    );
  });

  it('an exafy_admin caller may arm a control indefinitely (no duration_minutes required)', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-1', exafy_admin: true };
      next();
    };
    mockService.updateSystemControl.mockResolvedValue({ ok: true, control: {}, audit_id: 'a-2' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/governance/controls/EXECUTION_DISARMED')
      .send({ enabled: true, reason: 'incident response' });
    expect(res.status).toBe(200);
    expect(mockService.updateSystemControl).toHaveBeenCalledWith(
      'EXECUTION_DISARMED',
      expect.objectContaining({ duration_minutes: null })
    );
  });

  it('still requires a reason even for a verified exafy_admin caller', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-1', exafy_admin: true };
      next();
    };
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/governance/controls/EXECUTION_DISARMED')
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(mockService.updateSystemControl).not.toHaveBeenCalled();
  });

  it('a verified exafy_admin caller reaches GET /:key/history', async () => {
    mockAdminGuard.impl = (req: any, _res: any, next: any) => {
      req.identity = { user_id: 'admin-1', exafy_admin: true };
      next();
    };
    mockService.getControlAuditHistory.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app).get('/api/v1/governance/controls/EXECUTION_DISARMED/history');
    expect(res.status).toBe(200);
    expect(mockService.getControlAuditHistory).toHaveBeenCalledWith('EXECUTION_DISARMED', 50);
  });
});

describe('governance-controls router — source wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/routes/governance-controls.ts'),
    'utf8'
  );

  it('mounts requireAdminAuth on the whole router, before any route definition', () => {
    expect(source).toMatch(/import \{ requireAdminAuth, AuthenticatedRequest \} from '\.\.\/middleware\/auth-supabase-jwt'/);
    const useIdx = source.indexOf('router.use(requireAdminAuth)');
    const firstRouteIdx = source.indexOf("router.get('/'");
    expect(useIdx).toBeGreaterThan(-1);
    expect(firstRouteIdx).toBeGreaterThan(-1);
    expect(useIdx).toBeLessThan(firstRouteIdx);
  });

  it('getUserInfo reads the verified identity, never the old spoofable headers', () => {
    // The header names may still appear in prose (this file's own SECURITY
    // comment references the pre-fix behavior) — what must be gone is code
    // actually reading them off the request.
    expect(source).not.toMatch(/req\.headers\['x-user-role'\]/);
    expect(source).not.toMatch(/req\.headers\['x-user-id'\]/);
    expect(source).not.toMatch(/req\.headers\['x-operator-id'\]/);
    expect(source).toMatch(/\(req as AuthenticatedRequest\)\.identity/);
  });

  it('the old client-trusting role gate is gone', () => {
    expect(source).not.toMatch(/function canModifyControls/);
    expect(source).not.toMatch(/ALLOWED_ROLES/);
  });
});
