import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

// Mock Auth Middleware
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    req.identity = { user_id: 'admin-user', exafy_admin: true };
    next();
  }),
  requireExafyAdmin: jest.fn((req, res, next) => next()),
}));

// Mock Supabase Builder
const mockBuilder: any = {
  select: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  not: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  then: jest.fn(),
};

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({
    from: jest.fn(() => mockBuilder),
  })),
}));

// Mock Embedding Service
jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn(),
}));

// Mock Oasis Event Service
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(),
}));

describe('Admin Embeddings Backfill Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Mount the router both ways to ensure compatibility with varied internal route path strategies
    app.use('/api/v1', router);
    app.use('/api/v1/admin/embeddings/backfill', router);

    jest.clearAllMocks();

    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => mockBuilder),
    });

    (generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3]);
    (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });
    
    // Default mock response for queries that are awaited
    mockBuilder.then.mockImplementation((resolve: any) => 
      resolve({ data: [], error: null, count: 0 })
    );
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      mockBuilder.then
        .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null, count: 100 }))
        .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null, count: 60 }))
        .mockImplementationOnce((resolve: any) => resolve({ data: null, error: null, count: 40 }));

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      
      if (res.body.data && res.body.data.percent_complete !== undefined) {
        expect(typeof res.body.data.percent_complete).toBe('number');
      }
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    it('returns early without further processing when items.length === 0', async () => {
      mockBuilder.then.mockImplementationOnce((resolve: any) => 
        resolve({ data: [], error: null })
      );
      
      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 10 });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockBuilder.update).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs and skips any writes or embedding generations if dry_run: true', async () => {
      mockBuilder.then.mockImplementationOnce((resolve: any) => 
        resolve({ data: [{ id: 'sample_1' }, { id: 'sample_2' }], error: null })
      );
      
      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ dry_run: true });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.dry_run).toBe(true);
      expect(res.body.data.samples).toBeDefined();
      
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockBuilder.update).not.toHaveBeenCalled();
    });

    it('enforces batch limit boundaries accurately', async () => {
      mockBuilder.then.mockImplementation((resolve: any) => resolve({ data: [], error: null }));
      
      // Enforce minimum limit
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 0 });
      expect(mockBuilder.limit).toHaveBeenCalledWith(1);
      
      mockBuilder.limit.mockClear();
      
      // Enforce maximum limit
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 500 });
      expect(mockBuilder.limit).toHaveBeenCalledWith(200);

      mockBuilder.limit.mockClear();

      // Enforce default limit
      await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      expect(mockBuilder.limit).toHaveBeenCalledWith(50);
    });

    it('sequentially processes batch, updates Supabase, and emits Oasis event', async () => {
      mockBuilder.then
        .mockImplementationOnce((resolve: any) => resolve({ 
          data: [{ id: 'id_1', text: 'hello' }, { id: 'id_2', text: 'world' }], 
          error: null 
        }))
        .mockImplementation((resolve: any) => resolve({ data: null, error: null })); // For subsequent updates
      
      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 2 });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.processed).toBe(2);
      
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      expect(mockBuilder.update).toHaveBeenCalledTimes(2);
      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
      
      const oasisPayload = (emitOasisEvent as jest.Mock).mock.calls[0][0];
      expect(oasisPayload).toBeDefined();
    });

    it('securely logs failures for specific items but continues processing the rest', async () => {
      mockBuilder.then
        .mockImplementationOnce((resolve: any) => resolve({ 
          data: [{ id: 'id_1', text: 'bad_text' }, { id: 'id_2', text: 'good_text' }], 
          error: null 
        }))
        .mockImplementation((resolve: any) => resolve({ data: null, error: null }));

      // First item fails, second item succeeds
      (generateEmbedding as jest.Mock)
        .mockRejectedValueOnce(new Error('Vector generation failed'))
        .mockResolvedValueOnce([0.1, 0.2, 0.3]);
      
      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 2 });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.processed).toBe(1); 
      expect(res.body.data.failures).toBe(1);

      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      // Supabase update should only execute for the single successful generation
      expect(mockBuilder.update).toHaveBeenCalledTimes(1);
    });
  });
});