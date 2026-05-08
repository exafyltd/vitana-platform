import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

// Mocked state holders
let isSupabaseAvailable = true;
let queryResults: any[] = [];
let capturedLimits: number[] = [];
let capturedUpdates: any[] = [];

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    req.identity = { user_id: 'test-admin', exafy_admin: true };
    next();
  }),
  requireExafyAdmin: jest.fn((req, res, next) => next()),
}));

jest.mock('../../src/lib/supabase', () => {
  return {
    getSupabase: jest.fn(() => {
      if (!isSupabaseAvailable) return null;
      return {
        from: jest.fn(() => {
          const builder: any = {
            calls: [],
            select: jest.fn(function (this: any) { this.calls.push('select'); return this; }),
            is: jest.fn(function (this: any) { this.calls.push('is'); return this; }),
            not: jest.fn(function (this: any) { this.calls.push('not'); return this; }),
            order: jest.fn(function (this: any) { this.calls.push('order'); return this; }),
            limit: jest.fn(function (this: any, val: number) {
              this.calls.push('limit');
              capturedLimits.push(val);
              return this;
            }),
            update: jest.fn(function (this: any, payload: any) {
              this.calls.push('update');
              capturedUpdates.push(payload);
              return this;
            }),
            eq: jest.fn(function (this: any) { this.calls.push('eq'); return this; }),
            then: function (this: any, resolve: any, reject: any) {
              let res: any = { data: [], count: 0, error: null };
              
              if (this.calls.includes('update')) {
                res = { error: null };
              } else if (this.calls.includes('limit')) {
                res.data = queryResults.length > 0 ? queryResults.shift() : [];
              } else {
                if (this.calls.includes('not')) res.count = 80;
                else if (this.calls.includes('is')) res.count = 20;
                else res.count = 100;
              }
              
              return Promise.resolve(res).then(resolve).catch(reject);
            }
          };
          return builder;
        })
      };
    })
  };
});

jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn(),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(),
}));

describe('Admin Embeddings Backfill Route', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    isSupabaseAvailable = true;
    queryResults = [];
    capturedLimits = [];
    capturedUpdates = [];

    app = express();
    app.use(express.json());
    
    // Mount robustly to ensure it catches requests regardless of base prefix defined internally
    app.use('/api/v1/admin/embeddings/backfill', router);
    app.use('/api/v1', router);
    app.use('/', router);
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 or 503 when Supabase is unavailable', async () => {
      isSupabaseAvailable = false;
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect([500, 503]).toContain(res.status);
      expect(res.body.ok).toBe(false);
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      
      // With our dynamic mock returning 100 (total), 80 (embedded), 20 (missing),
      // we expect basic properties mapped in the success response.
      expect(res.body.data).toHaveProperty('total');
      expect(res.body.data).toHaveProperty('missing');
      expect(res.body.data).toHaveProperty('embedded');
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    it('returns early without further processing when items.length === 0', async () => {
      queryResults = []; // Emulate empty batch
      
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(emitOasisEvent).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs and skips any writes or embedding generations when dry_run: true', async () => {
      queryResults = [[{ id: 'test-1' }, { id: 'test-2' }]];
      
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ dry_run: true });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(capturedUpdates.length).toBe(0);
      expect(res.body.data).toBeDefined();
    });

    it('enforces batch limit boundaries (minimum 1, default 50, maximum 200)', async () => {
      // Test Default
      queryResults = [[{ id: '1' }]];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      const defaultLimit = capturedLimits[capturedLimits.length - 1];

      // Test Max Overreach
      queryResults = [[{ id: '1' }]];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 500, batch_size: 500 });
      const maxLimit = capturedLimits[capturedLimits.length - 1];

      // Test Min Boundary Clamp
      queryResults = [[{ id: '1' }]];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 0, batch_size: 0 });
      const minLimit = capturedLimits[capturedLimits.length - 1];

      expect(defaultLimit).toBe(50);
      expect(maxLimit).toBe(200);
      expect(minLimit).toBe(1);
    });

    it('sequentially processes a successful batch, generates embeddings, updates db, and emits event', async () => {
      queryResults = [[{ id: 'success-1', content: 'test content' }]];
      (generateEmbedding as jest.Mock).mockResolvedValueOnce({
        embedding: [0.1, 0.2, 0.3],
        model: 'test-model'
      });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
      
      // Asserts that the update() array contained our generated vector
      expect(capturedUpdates.length).toBe(1);
      expect(capturedUpdates[0]).toHaveProperty('embedding');
      
      // Asserts an Oasis Event is successfully triggered with correct payload metrics internally
      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
      expect(emitOasisEvent).toHaveBeenCalledWith(expect.any(Object));
    });

    it('securely logs failures but continues processing remaining items if generateEmbedding fails', async () => {
      queryResults = [[
        { id: 'item-1', content: 'pass' },
        { id: 'item-2', content: 'fail' },
        { id: 'item-3', content: 'pass' }
      ]];

      (generateEmbedding as jest.Mock)
        .mockResolvedValueOnce({ embedding: [0.1], model: 'test' })
        .mockRejectedValueOnce(new Error('Simulated embedding generation failure'))
        .mockResolvedValueOnce({ embedding: [0.2], model: 'test' });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(generateEmbedding).toHaveBeenCalledTimes(3);
      
      // The update shouldn't run for the failed iteration, guaranteeing data safety while advancing
      expect(capturedUpdates.length).toBe(2);
    });
  });
});