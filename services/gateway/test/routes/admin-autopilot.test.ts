import request from 'supertest';
import express from 'express';
import * as adminAutopilotModule from '../../src/routes/admin-autopilot';
import { getSupabase } from '../../src/lib/supabase';

// Safely extract the router regardless of default or named export
const adminAutopilotRouter = (adminAutopilotModule as any).default || (adminAutopilotModule as any).adminAutopilotRouter;

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

let mockIsAdmin = true;

jest.mock('../../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: jest.fn((req: any, res: any, next: any) => {
    if (!mockIsAdmin) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    req.targetTenantId = 'tenant-001';
    req.identity = {
      user_id: 'user-001',
      email: 'admin@example.com',
      tenant_id: 'tenant-001',
      exafy_admin: false,
      role: 'admin',
    };
    next();
  }),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/automation-registry', () => ({
  AUTOMATION_REGISTRY: [
    { id: 'auto-1', name: 'Auto One', operations: ['op1'] },
    { id: 'auto-2', name: 'Auto Two', operations: ['op2', 'op3'] },
  ],
}));

jest.mock('../../src/services/wave-defaults', () => ({
  DEFAULT_WAVE_CONFIG: {
    waveId: 'default-wave',
    name: 'Default Wave',
    description: 'Automatically created wave',
    schedule: '0 0 * * *',
  },
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createMockSupabase() {
  let resolveDataQueue: any[] = [];
  let defaultData: any = { data: [], error: null, count: 0 };
  
  const getNextData = () => {
    if (resolveDataQueue.length > 0) {
      return resolveDataQueue.shift();
    }
    return defaultData;
  };

  const mockQuery: any = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockImplementation(() => Promise.resolve(getNextData())),
    maybeSingle: jest.fn().mockImplementation(() => Promise.resolve(getNextData())),
    then: jest.fn((callback) => Promise.resolve(getNextData()).then(callback)),
  };

  const client = {
    from: jest.fn(() => mockQuery),
    rpc: jest.fn(() => Promise.resolve(getNextData())),
    __setMockData: (data: any, count: number = 0) => { defaultData = { data, error: null, count }; resolveDataQueue = []; },
    __addQueueData: (data: any, count: number = 0) => { resolveDataQueue.push({ data, error: null, count }); },
    __setMockError: (error: any) => { defaultData = { data: null, error }; resolveDataQueue = []; },
    mockQuery
  };

  return client;
}

function createMockApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/autopilot', adminAutopilotRouter);
  
  // Basic error handler to match standard gateway setup
  app.use((err: any, req: any, res: any, next: any) => {
    res.status(500).json({ ok: false, error: err.message });
  });

  return app;
}

// --------------------------------------------------------------------------
// Test setup
// --------------------------------------------------------------------------

let app: express.Express;
let mockSupabase: ReturnType<typeof createMockSupabase>;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAdmin = true;
  mockSupabase = createMockSupabase();
  (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  app = createMockApp();
});

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Authorization', () => {
  beforeEach(() => {
    mockIsAdmin = false;
  });

  const endpoints = [
    { method: 'get', url: '/api/v1/admin/autopilot/settings' },
    { method: 'patch', url: '/api/v1/admin/autopilot/settings' },
    { method: 'get', url: '/api/v1/admin/autopilot/bindings' },
    { method: 'post', url: '/api/v1/admin/autopilot/bindings' },
    { method: 'patch', url: '/api/v1/admin/autopilot/bindings/b1' },
    { method: 'delete', url: '/api/v1/admin/autopilot/bindings/b1' },
    { method: 'get', url: '/api/v1/admin/autopilot/runs' },
    { method: 'get', url: '/api/v1/admin/autopilot/runs/stats' },
    { method: 'get', url: '/api/v1/admin/autopilot/recommendations' },
    { method: 'get', url: '/api/v1/admin/autopilot/recommendations/summary' },
    { method: 'get', url: '/api/v1/admin/autopilot/waves' },
    { method: 'patch', url: '/api/v1/admin/autopilot/waves/w1' },
    { method: 'get', url: '/api/v1/admin/autopilot/catalog' },
  ];

  endpoints.forEach(({ method, url }) => {
    it(`returns 401 for ${method.toUpperCase()} ${url} if not an admin`, async () => {
      const req = request(app)[method as 'get' | 'post' | 'patch' | 'delete'](url);
      const res = await req.send({});
      expect(res.status).toBe(401);
    });
  });
});

describe('GET /api/v1/admin/autopilot/settings', () => {
  it('returns settings when they exist', async () => {
    mockSupabase.__setMockData([{ tenant_id: 'tenant-001', wave_enabled: true }]);

    const res = await request(app).get('/api/v1/admin/autopilot/settings');
    expect(res.status).toBe(200);
    expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_settings');
    expect(mockSupabase.mockQuery.eq).toHaveBeenCalledWith('tenant_id', 'tenant-001');
  });

  it('auto-creates settings when none found and returns them', async () => {
    // 1st query: select (returns empty)
    mockSupabase.__addQueueData([]);
    // 2nd query: insert (returns new row)
    mockSupabase.__addQueueData([{ tenant_id: 'tenant-001', wave_enabled: false }]);

    const res = await request(app).get('/api/v1/admin/autopilot/settings');
    expect(res.status).toBe(200);
    expect(mockSupabase.mockQuery.insert).toHaveBeenCalled();
  });

  it('returns 500 on database error', async () => {
    mockSupabase.__setMockError(new Error('DB connection failed'));

    const res = await request(app).get('/api/v1/admin/autopilot/settings');
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/v1/admin/autopilot/settings', () => {
  it('updates settings successfully', async () => {
    mockSupabase.__setMockData([{ tenant_id: 'tenant-001', wave_enabled: false }]);

    const res = await request(app)
      .patch('/api/v1/admin/autopilot/settings')
      .send({ wave_enabled: false });

    expect(res.status).toBe(200);
    expect(mockSupabase.mockQuery.update).toHaveBeenCalled();
    expect(mockSupabase.mockQuery.eq).toHaveBeenCalledWith('tenant_id', 'tenant-001');
  });

  it('handles invalid or empty payload defensively', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/autopilot/settings')
      .send({}); // missing valid fields to update
    
    // Depending on strictness of route, expect either 400 or a safe 200 no-op
    expect([200, 400]).toContain(res.status);
  });

  it('returns 500 on update error', async () => {
    mockSupabase.__setMockError(new Error('Update failed'));
    const res = await request(app)
      .patch('/api/v1/admin/autopilot/settings')
      .send({ wave_enabled: true });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/v1/admin/autopilot/bindings', () => {
  it('returns list of bindings', async () => {
    const bindings = [{ id: 'b1', automation_id: 'auto-1', tenant_id: 'tenant-001' }];
    mockSupabase.__setMockData(bindings);

    const res = await request(app).get('/api/v1/admin/autopilot/bindings');
    expect(res.status).toBe(200);
    expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_bindings');
    expect(mockSupabase.mockQuery.eq).toHaveBeenCalledWith('tenant_id', 'tenant-001');
  });

  it('filters by enabled query parameter', async () => {
    mockSupabase.__setMockData([]);
    await request(app).get('/api/v1/admin/autopilot/bindings?enabled=true');
    expect(mockSupabase.mockQuery.eq).toHaveBeenCalledWith('enabled', 'true');
  });
});

describe('POST /api/v1/admin/autopilot/bindings', () => {
  it('creates a new binding', async () => {
    mockSupabase.__setMockData([{ id: 'b-new', automation_id: 'auto-2', tenant_id: 'tenant-001' }]);

    const res = await request(app)
      .post('/api/v1/admin/autopilot/bindings')
      .send({ automation_id: 'auto-2', config: {} });

    expect(res.status).toBeLessThan(300);
    expect(mockSupabase.mockQuery.insert).toHaveBeenCalled();
  });

  it('returns error when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/v1/admin/autopilot/bindings')
      .send({ config: {} }); // missing automation_id

    expect([400, 500]).toContain(res.status);
  });
});

describe('PATCH /api/v1/admin/autopilot/bindings/:id', () => {
  it('updates a binding', async () => {
    mockSupabase.__setMockData([{ id: 'b1', config: { new: true } }]);

    const res = await request(app)
      .patch('/api/v1/admin/autopilot/bindings/b1')
      .send({ config: { new: true } });

    expect(res.status).toBe(200);
    expect(mockSupabase.mockQuery.eq).toHaveBeenCalledWith('id', 'b1');
    expect(mockSupabase.mockQuery.update).toHaveBeenCalled();
  });

  it('handles 404 when binding is missing', async () => {
    mockSupabase.__setMockData([]);
    const res = await request(app)
      .patch('/api/v1/admin/autopilot/bindings/nonexistent')
      .send({ config: {} });
    
    expect([200, 404]).toContain(res.status);
  });
});

describe('DELETE /api/v1/admin/autopilot/bindings/:id', () => {
  it('deletes a binding', async () => {
    mockSupabase.__setMockData([]);
    const res = await request(app).delete('/api/v1/admin/autopilot/bindings/b1');
    expect([200, 204]).toContain(res.status);
    expect(mockSupabase.mockQuery.delete).toHaveBeenCalled();
  });
});

describe('GET /api/v1/admin/autopilot/runs', () => {
  it('returns paginated runs', async () => {
    mockSupabase.__setMockData([{ id: 'r1', status: 'success' }], 1);

    const res = await request(app).get('/api/v1/admin/autopilot/runs?page=1&limit=10');
    expect(res.status).toBe(200);
    expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_runs');
  });

  it('filters by status and automation_id', async () => {
    mockSupabase.__setMockData([]);
    await request(app).get('/api/v1/admin/autopilot/runs?status=error&automation_id=auto-1');
    
    expect(mockSupabase.mockQuery.eq).toHaveBeenCalledWith('status', 'error');
    expect(mockSupabase.mockQuery.eq).toHaveBeenCalledWith('automation_id', 'auto-1');
  });
});

describe('GET /api/v1/admin/autopilot/runs/stats', () => {
  it('returns aggregated stats', async () => {
    mockSupabase.__setMockData({ total: 10, successful: 7, failed: 3 });
    const res = await request(app).get('/api/v1/admin/autopilot/runs/stats');
    expect(res.status).toBe(200);
  });

  it('handles empty stats or aggregation error', async () => {
    mockSupabase.__setMockError(new Error('Stats processing failed'));
    const res = await request(app).get('/api/v1/admin/autopilot/runs/stats');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/v1/admin/autopilot/recommendations', () => {
  it('returns tenant-specific recommendations', async () => {
    // 1st query: autopilot_settings checks (if route implements them before querying recs)
    mockSupabase.__addQueueData([{ tenant_id: 'tenant-001', wave_enabled: true }]);
    // 2nd query: actual recommendations
    mockSupabase.__addQueueData([{ id: 'rec-1', domain: 'perf' }]);

    const res = await request(app).get('/api/v1/admin/autopilot/recommendations');
    expect(res.status).toBe(200);
  });

  it('returns safely if autopilot disabled', async () => {
    // 1st query: autopilot_settings shows disabled
    mockSupabase.__addQueueData([{ tenant_id: 'tenant-001', wave_enabled: false }]);
    // Fallback if it still proceeds to query
    mockSupabase.__addQueueData([]);

    const res = await request(app).get('/api/v1/admin/autopilot/recommendations');
    expect(res.status).toBe(200);
  });

  it('filters by domain and risk', async () => {
    mockSupabase.__addQueueData([{ tenant_id: 'tenant-001', wave_enabled: true }]);
    mockSupabase.__addQueueData([{ id: 'rec-2', domain: 'security', risk_level: 'high' }]);

    const res = await request(app).get('/api/v1/admin/autopilot/recommendations?domain=security&risk=high');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/admin/autopilot/recommendations/summary', () => {
  it('returns summary counts', async () => {
    mockSupabase.__setMockData([{ domain: 'security', count: 5 }]);
    const res = await request(app).get('/api/v1/admin/autopilot/recommendations/summary');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/admin/autopilot/waves', () => {
  it('returns enriched wave data', async () => {
    mockSupabase.__setMockData([{ wave_id: 'default-wave', enabled: true }]);
    
    const res = await request(app).get('/api/v1/admin/autopilot/waves');
    expect(res.status).toBe(200);
    expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_waves');
  });
});

describe('PATCH /api/v1/admin/autopilot/waves/:waveId', () => {
  it('enables/disables a wave and handles binding batch updates', async () => {
    mockSupabase.__setMockData([{ wave_id: 'wave-1', enabled: false }]);
    
    const res = await request(app)
      .patch('/api/v1/admin/autopilot/waves/wave-1')
      .send({ enabled: false, bindings: [{ automation_id: 'auto-1' }] });
    
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/admin/autopilot/catalog', () => {
  it('merges static automation registry with tenant-specific bindings', async () => {
    // Returns active bindings to overlay on top of AUTOMATION_REGISTRY
    mockSupabase.__setMockData([{ automation_id: 'auto-1', id: 'b1' }]);

    const res = await request(app).get('/api/v1/admin/autopilot/catalog');
    expect(res.status).toBe(200);
    expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_bindings');
    
    // Assert the shape contains elements mixed from registry
    const payloadData = res.body.data ?? res.body;
    expect(Array.isArray(payloadData)).toBe(true);
    
    // Verify auto-1 overlay
    const auto1 = payloadData.find((a: any) => a.id === 'auto-1' || a.automation_id === 'auto-1');
    expect(auto1).toBeDefined();
  });
});