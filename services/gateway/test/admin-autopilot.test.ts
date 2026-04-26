/**
 * Tests for services/gateway/src/routes/admin-autopilot.ts
 *
 * Coverage:
 *  - requireTenantAdmin enforcement: no identity → 401
 *  - requireTenantAdmin enforcement: non-admin role → 403
 *  - GET /settings happy path: existing row returned
 *  - GET /settings: 503 when DB unavailable
 */

// ── Chainable Supabase mock (verbatim from autopilot-pipeline.test.ts) ────────

const createChainableMock = () => {
  let defaultData: any = { data: [], error: null };
  const responseQueue: any[] = [];

  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    neq: jest.fn(() => chain),
    gt: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    lt: jest.fn(() => chain),
    lte: jest.fn(() => chain),
    like: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    is: jest.fn(() => chain),
    in: jest.fn(() => chain),
    contains: jest.fn(() => chain),
    containedBy: jest.fn(() => chain),
    range: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    offset: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    or: jest.fn(() => chain),
    filter: jest.fn(() => chain),
    match: jest.fn(() => chain),
    then: jest.fn((resolve) => {
      const data = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(data).then(resolve);
    }),
    mockResolvedValue: (data: any) => {
      defaultData = data;
      return chain;
    },
    mockResolvedValueOnce: (data: any) => {
      responseQueue.push(data);
      return chain;
    },
    mockClear: () => {
      responseQueue.length = 0;
      defaultData = { data: [], error: null };
    },
  };

  return chain;
};

const mockSupabase = createChainableMock();

// ── Module mocks (must precede app import) ───────────────────────────────────

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

jest.mock('../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: jest.fn((req: any, _res: any, next: any) => {
    req.identity = { tenant_id: 'tenant-1', user_id: 'user-1', active_role: 'admin' };
    req.targetTenantId = 'tenant-1';
    next();
  }),
}));

jest.mock('../src/services/automation-registry', () => ({
  AUTOMATION_REGISTRY: [],
}));

jest.mock('../src/services/wave-defaults', () => ({
  DEFAULT_WAVE_CONFIG: [],
  WaveDefinition: {},
}));

jest.mock('../src/services/oasis-event-service', () => ({
  default: {
    deployRequested: jest.fn().mockResolvedValue(undefined),
    deployAccepted: jest.fn().mockResolvedValue(undefined),
    deployFailed: jest.fn().mockResolvedValue(undefined),
  },
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' }),
}));

jest.mock('../src/services/autopilot-event-loop', () => ({
  startEventLoop: jest.fn(),
  stopEventLoop: jest.fn(),
  getEventLoopStatus: jest.fn().mockResolvedValue({
    ok: true,
    is_running: true,
    execution_armed: true,
  }),
  getEventLoopHistory: jest.fn().mockResolvedValue([]),
  resetEventLoopCursor: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../src/services/ai-orchestrator', () => ({
  processMessage: jest.fn().mockResolvedValue({
    reply: 'test response',
    meta: { model: 'test-model', stub: true },
  }),
}));

jest.mock('../src/services/github-service', () => ({
  default: {
    triggerWorkflow: jest.fn().mockResolvedValue(undefined),
    getWorkflowRuns: jest.fn().mockResolvedValue({ workflow_runs: [] }),
  },
}));

jest.mock('../src/services/deploy-orchestrator', () => ({
  __esModule: true,
  default: {
    executeDeploy: jest.fn(),
    createVtid: jest.fn(),
    createTask: jest.fn(),
  },
}));

// ── App + helpers (after mocks) ───────────────────────────────────────────────

import request from 'supertest';
import app from '../src/index';
import { requireTenantAdmin } from '../src/middleware/require-tenant-admin';
import { getSupabase } from '../src/lib/supabase';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('admin-autopilot routes', () => {
  beforeEach(() => {
    mockSupabase.mockClear();
    // Restore default: inject identity and call next()
    (requireTenantAdmin as jest.Mock).mockImplementation(
      (req: any, _res: any, next: any) => {
        req.identity = { tenant_id: 'tenant-1', user_id: 'user-1', active_role: 'admin' };
        req.targetTenantId = 'tenant-1';
        next();
      }
    );
    // Restore getSupabase to return the chainable mock
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  describe('requireTenantAdmin enforcement', () => {
    it('returns 401 when no identity is present', async () => {
      (requireTenantAdmin as jest.Mock).mockImplementationOnce(
        (_req: any, res: any) => {
          res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
        }
      );

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(401);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('returns 403 when caller does not have admin role', async () => {
      (requireTenantAdmin as jest.Mock).mockImplementationOnce(
        (_req: any, res: any) => {
          res.status(403).json({ ok: false, error: 'FORBIDDEN' });
        }
      );

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(403);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('FORBIDDEN');
    });
  });

  describe('GET /api/v1/admin/autopilot/settings', () => {
    it('returns 200 with settings when an existing row is found', async () => {
      mockSupabase.mockResolvedValueOnce({
        data: { tenant_id: 'tenant-1', enabled: true },
        error: null,
      });

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.data).toMatchObject({
        tenant_id: 'tenant-1',
        enabled: true,
      });
    });

    it('returns 503 DB_UNAVAILABLE when getSupabase returns null', async () => {
      (getSupabase as jest.Mock).mockReturnValueOnce(null);

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(503);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('DB_UNAVAILABLE');
    });
  });
});