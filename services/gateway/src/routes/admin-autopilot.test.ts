import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import adminAutopilotRouter from './admin-autopilot';

// Global mock state variables
let mockData: any[] | null = [];
let mockCount: number | null = null;
let mockSingleData: any = null;
let mockMaybeSingleData: any = null;
let mockError: any = null;

// Chainable mock definition for Supabase queries
const chainable: any = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  gte: jest.fn().mockReturnThis(),
  lte: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  range: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  upsert: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn().mockImplementation(() => Promise.resolve({ data: mockMaybeSingleData, error: mockError })),
  single: jest.fn().mockImplementation(() => Promise.resolve({ data: mockSingleData, error: mockError })),
  then: jest.fn().mockImplementation((resolve: (value: any) => void) => {
    resolve({ data: mockData, error: mockError, count: mockCount ?? (mockData ? mockData.length : 0) });
  }),
};

const mockSupabase = {
  from: jest.fn(() => chainable),
};

jest.mock('../lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

// We need to define an extended request to avoid TS errors
interface AdminRequest extends Request {
  targetTenantId?: string;
}

jest.mock('../middleware/require-tenant-admin', () => ({
  requireTenantAdmin: jest.fn((req: AdminRequest, res: Response, next: NextFunction) => {
    // Inject mock tenant ID to simulate authorized tenant admin
    req.targetTenantId = 'tenant-123';
    next();
  }),
}));

const app = express();
app.use(express.json());
app.use('/', adminAutopilotRouter);

describe('Admin Autopilot Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockData = [];
    mockCount = null;
    mockSingleData = null;
    mockMaybeSingleData = null;
    mockError = null;
  });

  describe('Settings', () => {
    describe('GET /settings', () => {
      it('should provision and return settings if they do not exist', async () => {
        mockMaybeSingleData = null;
        mockSingleData = { tenant_id: 'tenant-123', autopilot_enabled: false };
        
        const res = await request(app).get('/settings');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(chainable.insert).toHaveBeenCalled();
      });

      it('should return existing settings', async () => {
        mockMaybeSingleData = { tenant_id: 'tenant-123', autopilot_enabled: true };
        
        const res = await request(app).get('/settings');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.autopilot_enabled).toBe(true);
        expect(chainable.insert).not.toHaveBeenCalled();
      });
    });

    describe('PATCH /settings', () => {
      it('should return 400 if body is empty', async () => {
        const res = await request(app).patch('/settings').send({});
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
      });

      it('should successfully update settings', async () => {
        mockSingleData = { tenant_id: 'tenant-123', autopilot_enabled: true };
        
        const res = await request(app).patch('/settings').send({ autopilot_enabled: true });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(chainable.update).toHaveBeenCalled();
      });
    });
  });

  describe('Bindings', () => {
    describe('GET /bindings', () => {
      it('should return an array of bindings', async () => {
        mockData = [{ id: 'bind-1', automation_id: 'auto-1' }];
        const res = await request(app).get('/bindings');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toHaveLength(1);
      });
    });

    describe('POST /bindings', () => {
      it('should return 400 if automation_id is missing', async () => {
        const res = await request(app).post('/bindings').send({ is_active: true });
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
      });

      it('should successfully upsert a binding', async () => {
        mockSingleData = { id: 'bind-1', automation_id: 'auto-1' };
        const res = await request(app).post('/bindings').send({ automation_id: 'auto-1' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(chainable.upsert).toHaveBeenCalled();
      });
    });

    describe('PATCH /bindings/:bindingId', () => {
      it('should update a binding successfully', async () => {
        mockSingleData = { id: 'bind-1', is_active: false };
        const res = await request(app).patch('/bindings/bind-1').send({ is_active: false });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(chainable.update).toHaveBeenCalled();
      });
    });

    describe('DELETE /bindings/:bindingId', () => {
      it('should delete a binding successfully', async () => {
        mockSingleData = null;
        const res = await request(app).delete('/bindings/bind-1');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(chainable.delete).toHaveBeenCalled();
      });
    });
  });

  describe('Runs', () => {
    describe('GET /runs', () => {
      it('should paginate and return run data with count', async () => {
        mockData = [{ id: 'run-1' }, { id: 'run-2' }];
        mockCount = 10;
        
        const res = await request(app).get('/runs?page=1&limit=2');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toHaveLength(2);
        expect(chainable.range).toHaveBeenCalled();
      });
    });

    describe('GET /runs/stats', () => {
      it('should return standard statistics for runs', async () => {
        mockData = [
          { status: 'success' },
          { status: 'error' },
        ];
        
        const res = await request(app).get('/runs/stats');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(chainable.gte).toHaveBeenCalled();
      });
    });
  });

  describe('Recommendations', () => {
    describe('GET /recommendations', () => {
      it('should simulate filtering via settings and return recommendations', async () => {
        mockData = [{ id: 'rec-1', risk_level: 'high' }];
        
        const res = await request(app).get('/recommendations?risk_level=high');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toHaveLength(1);
      });
    });

    describe('GET /recommendations/summary', () => {
      it('should resolve counts and correctly structure output', async () => {
        mockData = [{ status: 'pending', count: 5 }];
        
        const res = await request(app).get('/recommendations/summary');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      });
    });
  });

  describe('Waves', () => {
    describe('GET /waves', () => {
      it('should return wave lists merged with binding mock maps', async () => {
        mockData = [{ id: 'wave-1' }];
        
        const res = await request(app).get('/waves');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      });
    });

    describe('PATCH /waves/:waveId', () => {
      it('should update a wave', async () => {
        mockSingleData = { id: 'wave-1', is_active: false };
        const res = await request(app).patch('/waves/wave-1').send({ is_active: false });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(chainable.update).toHaveBeenCalled();
      });
    });
  });

  describe('Catalog', () => {
    describe('GET /catalog', () => {
      it('should return mapped automation catalog data', async () => {
        const res = await request(app).get('/catalog');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      });
    });
  });
});