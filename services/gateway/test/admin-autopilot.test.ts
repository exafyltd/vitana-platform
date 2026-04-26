/**
 * Tests for src/routes/admin-autopilot.ts
 *
 * Covers:
 *  - requireTenantAdmin access-control contract (401, 403)
 *  - GET /api/v1/admin/autopilot/settings happy path
 *  - GET /api/v1/admin/autopilot/settings when DB is unavailable (503)
 */

import request from 'supertest';
import { NextFunction, Request, Response } from 'express';

// ── Chainable Supabase mock (copied from autopilot-pipeline.test.ts) ──────────

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
    upsert: jest.fn(() => chain),
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

jest.mock('../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: jest.fn((req: Request, _res: Response, next: NextFunction) => {
    (req as any).identity = { tenant_id: 'tenant-1', user_id: 'user-1', active_role: 'admin' };
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

const { getSupabase } = require('../src/lib/supabase');
const { requireTenantAdmin } = require('../src/middleware/require-tenant-admin');

const DEFAULT_IDENTITY = {
  tenant_id: 'tenant-1',
  user_id: 'user-1',
  active_role: 'admin',
};

function resetMiddlewareToDefault() {
  requireTenantAdmin.mockImplementation(
    (req: Request, _res: Response, next: NextFunction) => {
      (req as any).identity = DEFAULT_IDENTITY;
      next();
    }
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('admin-autopilot route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabase.mockClear();
    getSupabase.mockReturnValue(mockSupabase);
    resetMiddlewareToDefault();
  });

  // ── Access-control ────────────────────────────────────────────────────────

  describe('requireTenantAdmin enforcement', () => {
    it('returns 401 when middleware rejects with no identity', async () => {
      requireTenantAdmin.mockImplementation(
        (_req: Request, res: Response, _next: NextFunction) => {
          res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
        }
      );

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(401);

      expect(response.body.ok).toBe(false);
    });

    it('returns 403 when middleware rejects with non-admin role', async () => {
      requireTenantAdmin.mockImplementation(
        (_req: Request, res: Response, _next: NextFunction) => {
          res.status(403).json({ ok: false, error: 'FORBIDDEN' });
        }
      );

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(403);

      expect(response.body.ok).toBe(false);
    });
  });

  // ── GET /settings ─────────────────────────────────────────────────────────

  describe('GET /api/v1/admin/autopilot/settings', () => {
    it('returns 200 with settings row when one exists', async () => {
      const settingsRow = { tenant_id: 'tenant-1', enabled: true };
      mockSupabase.mockResolvedValueOnce({ data: settingsRow, error: null });

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.data).toMatchObject({
        tenant_id: 'tenant-1',
        enabled: true,
      });
    });

    it('returns 503 with DB_UNAVAILABLE when getSupabase returns null', async () => {
      getSupabase.mockReturnValueOnce(null);

      const response = await request(app)
        .get('/api/v1/admin/autopilot/settings')
        .expect(503);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('DB_UNAVAILABLE');
    });
  });
});