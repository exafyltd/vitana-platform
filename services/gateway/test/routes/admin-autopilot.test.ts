import express from 'express';
import request from 'supertest';
import adminAutopilotRouter from '../../src/routes/admin-autopilot';

// Mock dependencies
const mockSupabase = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
  single: jest.fn(),
  // Helper to set the promise result for the final method in a chain
  __setMockResult: (result: { data?: any; error?: any; count?: number }) => {
    const promise = Promise.resolve(result);
    // These are the methods that can terminate a chain and return a promise
    (mockSupabase.select as jest.Mock).mockReturnValue(promise);
    (mockSupabase.update as jest.Mock).mockReturnValue(promise);
    (mockSupabase.insert as jest.Mock).mockReturnValue(promise);
    (mockSupabase.delete as jest.Mock).mockReturnValue(promise);
    (mockSupabase.single as jest.Mock).mockReturnValue(promise);
  },
  __clearMocks: () => {
    // Reset mocks and restore default chaining behavior
    const chainedMethods = [
      'from',
      'select',
      'update',
      'insert',
      'delete',
      'eq',
      'in',
      'or',
      'order',
      'range',
    ];
    chainedMethods.forEach((method) => {
      (mockSupabase[method] as jest.Mock).mockClear().mockReturnThis();
    });
    (mockSupabase.single as jest.Mock).mockClear();
    // Reset from's implementation to the default simple chain
    (mockSupabase.from as jest.Mock).mockImplementation(() => mockSupabase);
  },
};

jest.mock('../../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: (req, res, next) => {
    req.tenant = { id: 'test-tenant-id' };
    req.user = { id: 'test-user-id' };
    next();
  },
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

const mockAutomationRegistry = [
  {
    id: 'automation-1',
    name: 'Automation One',
    description: 'First automation',
    for: ['pull_request'],
    tags: ['test', 'pr'],
    recommend: { type: 'always' },
    actions: [],
  },
  {
    id: 'automation-2',
    name: 'Automation Two',
    description: 'Second automation',
    for: ['issue'],
    tags: ['test', 'issue'],
    recommend: { type: 'never' },
    actions: [],
  },
];
jest.mock('../../src/services/automation-registry', () => ({
  AUTOMATION_REGISTRY: mockAutomationRegistry,
}));

jest.mock('../../src/services/wave-defaults', () => ({
  DEFAULT_WAVE_CONFIG: {
    name: 'Default Wave Name',
    enabled: true,
    rules: [{ if: 'true', then: 'pass' }],
  },
}));

const app = express();
app.use(express.json());
app.use('/api/v1/admin/autopilot', adminAutopilotRouter);

describe('Admin Autopilot Routes', () => {
  beforeEach(() => {
    mockSupabase.__clearMocks();
  });

  describe('Settings', () => {
    it('GET /settings should return existing settings', async () => {
      const settings = { tenant_id: 'test-tenant-id', enabled: true };
      mockSupabase.__setMockResult({ data: settings, error: null });

      const res = await request(app).get('/api/v1/admin/autopilot/settings');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(settings);
      expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_settings');
      expect(mockSupabase.select).toHaveBeenCalledWith('*');
      expect(mockSupabase.eq).toHaveBeenCalledWith('tenant_id', 'test-tenant-id');
      expect(mockSupabase.single).toHaveBeenCalled();
    });

    it('GET /settings should create and return default settings if none exist', async () => {
      // First call to select returns null
      (mockSupabase.single as jest.Mock).mockResolvedValueOnce({ data: null, error: null });

      const newSettings = { id: 'new-uuid', tenant_id: 'test-tenant-id', enabled: false };
      // Second call (insert) returns the new settings
      mockSupabase.__setMockResult({ data: [newSettings], error: null });

      const res = await request(app).get('/api/v1/admin/autopilot/settings');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(newSettings);
      expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_settings');
      expect(mockSupabase.insert).toHaveBeenCalledWith({
        tenant_id: 'test-tenant-id',
        enabled: false,
      });
    });

    it('GET /settings should handle database errors on fetch', async () => {
      mockSupabase.__setMockResult({ data: null, error: { message: 'DB error' } });
      const res = await request(app).get('/api/v1/admin/autopilot/settings');
      expect(res.status).toBe(500);
    });

    it('PATCH /settings should update settings', async () => {
      const updatedSettings = { tenant_id: 'test-tenant-id', enabled: true };
      mockSupabase.__setMockResult({ data: [updatedSettings], error: null });

      const res = await request(app)
        .patch('/api/v1/admin/autopilot/settings')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(updatedSettings);
      expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_settings');
      expect(mockSupabase.update).toHaveBeenCalledWith({ enabled: true });
      expect(mockSupabase.eq).toHaveBeenCalledWith('tenant_id', 'test-tenant-id');
    });

    it('PATCH /settings should return 400 on invalid body', async () => {
      const res = await request(app)
        .patch('/api/v1/admin/autopilot/settings')
        .send({ enabled: 'not-a-boolean' });
      expect(res.status).toBe(400);
    });
  });

  describe('Bindings', () => {
    it('GET /bindings should return a list of bindings', async () => {
      const bindings = [{ id: 'b1', automation_id: 'automation-1' }];
      mockSupabase.__setMockResult({ data: bindings, error: null });
      const res = await request(app).get('/api/v1/admin/autopilot/bindings');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(bindings);
      expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_bindings');
    });

    it('POST /bindings should create a new binding', async () => {
      const newBinding = { automation_id: 'automation-1', config: { key: 'value' } };
      const createdBinding = { id: 'new-b1', ...newBinding };
      mockSupabase.__setMockResult({ data: [createdBinding], error: null });

      const res = await request(app).post('/api/v1/admin/autopilot/bindings').send(newBinding);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(createdBinding);
      expect(mockSupabase.insert).toHaveBeenCalledWith([
        { ...newBinding, tenant_id: 'test-tenant-id' },
      ]);
    });

    it('PATCH /bindings/:bindingId should update a binding', async () => {
      const updatedBinding = { id: 'b1', config: { updated: true } };
      mockSupabase.__setMockResult({ data: [updatedBinding], error: null });

      const res = await request(app)
        .patch('/api/v1/admin/autopilot/bindings/b1')
        .send({ config: { updated: true } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(updatedBinding);
      expect(mockSupabase.update).toHaveBeenCalledWith({ config: { updated: true } });
      expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'b1');
    });

    it('DELETE /bindings/:bindingId should delete a binding', async () => {
      mockSupabase.__setMockResult({ data: [{ id: 'b1' }], error: null }); // simulate successful delete
      const res = await request(app).delete('/api/v1/admin/autopilot/bindings/b1');
      expect(res.status).toBe(204);
      expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_bindings');
      expect(mockSupabase.delete).toHaveBeenCalled();
      expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'b1');
    });

    it('DELETE /bindings/:bindingId should return 404 if not found', async () => {
      mockSupabase.__setMockResult({ data: [], error: null }); // simulate not found
      const res = await request(app).delete('/api/v1/admin/autopilot/bindings/b1');
      expect(res.status).toBe(404);
    });
  });

  describe('Runs', () => {
    it('GET /runs should fetch paginated runs', async () => {
      const runs = [{ id: 'run1' }, { id: 'run2' }];
      mockSupabase.__setMockResult({ data: runs, error: null, count: 50 });

      const res = await request(app).get('/api/v1/admin/autopilot/runs?page=1&limit=2');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(runs);
      expect(res.headers['x-total-count']).toBe('50');
      expect(mockSupabase.range).toHaveBeenCalledWith(0, 1);
    });

    it('GET /runs/stats should return run statistics', async () => {
      const stats = [
        { status: 'success', count: 10 },
        { status: 'failure', count: 2 },
      ];
      mockSupabase.__setMockResult({ data: stats, error: null });
      const res = await request(app).get('/api/v1/admin/autopilot/runs/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: 10,
        failure: 2,
        running: 0,
        total: 12,
      });
    });
  });

  describe('Recommendations', () => {
    it('GET /recommendations should return recommendations for the tenant', async () => {
      const recommendations = [{ id: 'rec1' }];
      mockSupabase.__setMockResult({ data: recommendations, error: null });

      const res = await request(app).get('/api/v1/admin/autopilot/recommendations');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(recommendations);
      expect(mockSupabase.from).toHaveBeenCalledWith('autopilot_recommendations');
      expect(mockSupabase.eq).toHaveBeenCalledWith('tenant_id', 'test-tenant-id');
    });
  });

  describe('Waves', () => {
    it('GET /waves should return enriched wave data', async () => {
      const wave = {
        id: 'wave1',
        name: 'Wave One',
        enabled: true,
        rules: [{ automation_id: 'automation-1' }],
      };
      const binding = { id: 'b1', automation_id: 'automation-1' };

      (mockSupabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'autopilot_waves') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockResolvedValue({ data: [wave], error: null }),
          };
        }
        if (table === 'autopilot_bindings') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({ data: [binding], error: null }),
          };
        }
        return mockSupabase; // Fallback to default mock behavior
      });

      const res = await request(app).get('/api/v1/admin/autopilot/waves');

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe('wave1');
      expect(res.body[0].automations).toBeDefined();
      expect(res.body[0].automations.length).toBe(1);
      expect(res.body[0].automations[0].id).toBe('automation-1');
      expect(res.body[0].automations[0].binding).toEqual(binding);
    });
  });

  describe('Catalog', () => {
    it('GET /catalog should merge registry automations with tenant bindings', async () => {
      const bindings = [{ id: 'b1', automation_id: 'automation-1', enabled: false, config: {} }];
      mockSupabase.__setMockResult({ data: bindings, error: null });

      const res = await request(app).get('/api/v1/admin/autopilot/catalog');

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(mockAutomationRegistry.length);

      const boundItem = res.body.find((item) => item.id === 'automation-1');
      const unboundItem = res.body.find((item) => item.id === 'automation-2');

      expect(boundItem.binding).toBeDefined();
      expect(boundItem.binding.id).toBe('b1');
      expect(boundItem.binding.enabled).toBe(false);
      expect(unboundItem.binding).toBeNull();
    });

    it('GET /catalog should handle DB errors', async () => {
      mockSupabase.__setMockResult({ data: null, error: { message: 'DB Error' } });
      const res = await request(app).get('/api/v1/admin/autopilot/catalog');
      expect(res.status).toBe(500);
    });
  });
});