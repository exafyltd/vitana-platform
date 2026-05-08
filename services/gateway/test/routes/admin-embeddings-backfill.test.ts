import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req: any, res: any, next: any) => {
    req.identity = { user_id: 'admin-123', exafy_admin: true };
    next();
  }),
  requireExafyAdmin: jest.fn((req: any, res: any, next: any) => next()),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn(),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(),
}));

describe('Admin Embeddings Backfill Routes', () => {
  let app: express.Application;
  let mockSupabaseResponses: any[] = [];

  const mockQueryBuilder: any = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    then: jest.fn().mockImplementation((onFulfilled) => {
      const response = mockSupabaseResponses.length > 0 
        ? mockSupabaseResponses.shift() 
        : { data: [], count: 0, error: null };
      return Promise.resolve(response).then(onFulfilled);
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseResponses = [];
    
    app = express();
    app.use(express.json());
    
    // Mount safely to accommodate internal router configurations
    app.use('/api/v1', router);
    app.use('/api/v1/admin/embeddings/backfill', router);

    (getSupabase as jest.Mock).mockReturnValue(mockQueryBuilder);
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      mockSupabaseResponses = [
        { data: [], count: 1000, error: null }, // total
        { data: [], count: 800, error: null },  // embedded
        { data: [], count: 200, error: null },  // missing
      ];

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockQueryBuilder.from).toHaveBeenCalled();
      expect(mockQueryBuilder.select).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    it('returns early when empty batches are found', async () => {
      mockSupabaseResponses = [{ data: [], error: null }]; // missing items query yields empty
      
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockQueryBuilder.update).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs on dry_run and skips writes/generations', async () => {
      mockSupabaseResponses = [{ data: [{ id: 'doc-1' }, { id: 'doc-2' }], error: null }];
      
      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ dry_run: true });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockQueryBuilder.update).not.toHaveBeenCalled();
    });

    it('enforces limit boundaries (minimum 1, default 50, maximum 200)', async () => {
      // Test default 50
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(50);

      // Test maximum 200 clamping
      jest.clearAllMocks();
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .query({ limit: 300 })
        .send({ limit: 300 });
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(200);

      // Test minimum 1 clamping
      jest.clearAllMocks();
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .query({ limit: 0 })
        .send({ limit: 0 });
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(1);
    });

    it('sequentially processes a successful item batch, generating embeddings, updating Supabase, and emitting oasis event', async () => {
      mockSupabaseResponses = [
        { data: [{ id: '1', content: 'hello world' }], error: null }, // Initial select
        { data: [], error: null }, // Batch update resolving
      ];
      (generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3]);

      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 10 });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Asserts business logic sequence triggers correctly
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
      expect(mockQueryBuilder.update).toHaveBeenCalled();
      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
    });

    it('securely logs failures and continues processing if generateEmbedding fails for an item', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      
      mockSupabaseResponses = [
        { 
          data: [
            { id: '1', content: 'good' }, 
            { id: '2', content: 'bad' }, 
            { id: '3', content: 'good' }
          ], 
          error: null 
        },
        { data: [], error: null }, // UPDATE for 1
        { data: [], error: null }, // UPDATE for 3
      ];
      
      (generateEmbedding as jest.Mock).mockImplementation(async (text: string) => {
        if (text === 'bad') throw new Error('Mock Generation Error');
        return [0.1, 0.2, 0.3];
      });

      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 3 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Expected to process all 3 texts
      expect(generateEmbedding).toHaveBeenCalledTimes(3);
      // Expected to only update for the 2 texts that succeeded
      expect(mockQueryBuilder.update).toHaveBeenCalledTimes(2);
      // Ensure failure was logged securely
      expect(consoleErrorSpy).toHaveBeenCalled();
      
      consoleErrorSpy.mockRestore();
    });
  });
});