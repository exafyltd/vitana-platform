import request from 'supertest';

// ── Chainable Supabase mock (same pattern as autopilot-pipeline.test.ts) ──────

const createChainableMock = () => {
  let defaultData: any = { data: [], error: null };
  const responseQueue: any[] = [];

  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    upsert: jest.fn(() => chain),
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

// ── Module mocks — must appear before any app import ─────────────────────────

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

// Default implementation: inject a valid admin identity and call next().
// Individual tests can override this with mockImplementationOnce.
jest.mock('../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: jest.fn((req: any, _res: any, next: any) => {
    req.identity = { tenant_id: 'tenant-1', user_id: 'user-1', active_role: 'admin' };
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

// ── Import app after all mocks ────────────────────────────────────────────────

import app from '../src/index';
import { requireTenantAdmin } from '../src/middleware/require-tenant-admin';
import { getSupabase } from '../src/lib/supabase';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('admin-autopilot routes', () => {
  beforeEach(() => {
    mockSupabase.mockClear();
    jest.clearAllMocks();

    // Reset requireTenantAdmin to the default "inject identity + call next()" implementation.
    (requireTenantAdmin as jest.Mock).mockImplementation((req: any, _res: any, next: any) => {
      req.identity = { tenant_id: 'tenant-1', user_id: 'user-1', active_role: 'admin' };
      next();
    });

    // Reset getSupabase to return the chainable mock.
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  // ── Access-control contract ─────────────────────────────────────────────────

  describe('requireTenantAdmin enforcement', () => {
    it('returns 401 when no identity is present', async () => {
      (requireTenantAdmin as jest.Mock).mockImplementationOnce((_req: any, res: any) => {
        res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      });

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(401);

      expect(response.body.ok).toBe(false);
    });

    it('returns 403 when caller has a non-admin role', async () => {
      (requireTenantAdmin as jest.Mock).mockImplementationOnce((_req: any, res: any) => {
        res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      });

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(403);

      expect(response.body.ok).toBe(false);
    });
  });

  // ── GET /settings ───────────────────────────────────────────────────────────

  describe('GET /api/v1/admin/autopilot/settings', () => {
    it('returns 200 with the settings row when it exists', async () => {
      const settingsRow = { tenant_id: 'tenant-1', enabled: true };
      mockSupabase.mockResolvedValueOnce({ data: settingsRow, error: null });

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.data).toMatchObject({ tenant_id: 'tenant-1', enabled: true });
    });

    it('returns 503 DB_UNAVAILABLE when getSupabase() returns null', async () => {
      (getSupabase as jest.Mock).mockReturnValueOnce(null);

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(503);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('DB_UNAVAILABLE');
    });
  });
});