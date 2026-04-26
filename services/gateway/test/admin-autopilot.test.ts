import request from 'supertest';

// ── Chainable Supabase mock (copied from autopilot-pipeline.test.ts) ──────────

const createChainableMock = () => {
  let defaultData: any = { data: null, error: null };
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
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const mockSupabase = createChainableMock();

// ── Module mocks (must appear before app import) ──────────────────────────────

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

// requireTenantAdmin: default impl injects identity and calls next()
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

// ── App import (after all mocks) ──────────────────────────────────────────────

import app from '../src/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

const { requireTenantAdmin } = require('../src/middleware/require-tenant-admin');
const { getSupabase } = require('../src/lib/supabase');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('admin-autopilot routes', () => {
  beforeEach(() => {
    mockSupabase.mockClear();
    jest.clearAllMocks();

    // Reset requireTenantAdmin to the default pass-through
    (requireTenantAdmin as jest.Mock).mockImplementation((req: any, _res: any, next: any) => {
      req.identity = { tenant_id: 'tenant-1', user_id: 'user-1', active_role: 'admin' };
      next();
    });

    // Reset getSupabase to return the chainable mock
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  // ── Access control ──────────────────────────────────────────────────────────

  it('returns 401 when no identity (unauthenticated)', async () => {
    (requireTenantAdmin as jest.Mock).mockImplementation((_req: any, res: any) => {
      res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    });

    const res = await request(app).get('/api/v1/admin/autopilot/settings');
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller has non-admin role', async () => {
    (requireTenantAdmin as jest.Mock).mockImplementation((_req: any, res: any) => {
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    });

    const res = await request(app).get('/api/v1/admin/autopilot/settings');
    expect(res.status).toBe(403);
  });

  // ── GET /settings ───────────────────────────────────────────────────────────

  it('GET /settings returns existing row (happy path)', async () => {
    const settingsRow = { tenant_id: 'tenant-1', enabled: true };
    mockSupabase.mockResolvedValueOnce({ data: settingsRow, error: null });

    const res = await request(app).get('/api/v1/admin/autopilot/settings');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { tenant_id: 'tenant-1', enabled: true } });
  });

  it('GET /settings returns 503 when DB unavailable', async () => {
    (getSupabase as jest.Mock).mockReturnValue(null);

    const res = await request(app).get('/api/v1/admin/autopilot/settings');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'DB_UNAVAILABLE' });
  });
});