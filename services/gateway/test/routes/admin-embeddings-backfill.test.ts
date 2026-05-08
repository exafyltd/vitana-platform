import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// Mocks MUST be hoisted before importing routes that use them
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).identity = { user_id: 'admin-123', exafy_admin: true };
    next();
  }),
  requireExafyAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    next();
  })
}));

jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn()
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn()
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

const createMockQuery = () => {
  const q: any = {
    select: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    then: jest.fn((resolve) => resolve({ data: [], error: null, count: 0 }))
  };
  return q;
};

describe('admin-embeddings-backfill routes', () => {
  let app: express.Application;
  let mockSupabase: any;
  let capturedQueries: any[];

  beforeEach(() => {
    jest.clearAllMocks();
    
    capturedQueries = [];
    mockSupabase = {
      from: jest.fn(() => {
        const q = createMockQuery();
        capturedQueries.push(q);
        return q;
      })
    };
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

    app = express();
    app.use(express.json());
    app.use('/api/v1', router);
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      expect(res.status).toBe(500);
      expect(res.body).toEqual(expect.objectContaining({ ok: false, error: expect.any(String) }));
    });

    it('returns correct percentages when providing total, embedded, and missing counts', async () => {
      mockSupabase.from.mockImplementation(() => {
        const q = createMockQuery();
        q.then.mockImplementation((resolve: any) => {
          let count = 100;
          if (q.not.mock.calls.length > 0) count = 80;
          else if (q.is.mock.calls.length > 0) count = 20;
          resolve({ data: [], error: null, count });
        });
        return q;
      });

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(mockSupabase.from).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    it('returns early when items.length === 0', async () => {
      mockSupabase.from.mockImplementation(() => {
        const q = createMockQuery();
        q.then.mockImplementation((resolve: any) => resolve({ data: [], error: null }));
        return q;
      });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 10 });
      expect(res.status).toBe(200);
      expect(generateEmbedding).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs and skips writes when dry_run: true', async () => {
      mockSupabase.from.mockImplementation(() => {
        const q = createMockQuery();
        q.then.mockImplementation((resolve: any) => resolve({
          data: [{ id: 'sample-1' }], error: null
        }));
        return q;
      });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ dry_run: true });
      expect(res.status).toBe(200);
      expect(generateEmbedding).not.toHaveBeenCalled();
      
      const updateQueries = capturedQueries.filter(q => q.update.mock.calls.length > 0);
      expect(updateQueries.length).toBe(0);
    });

    it('enforces batch limit boundaries (min 1, default 50, max 200)', async () => {
      mockSupabase.from.mockImplementation(() => {
        const q = createMockQuery();
        capturedQueries.push(q);
        q.then.mockImplementation((resolve: any) => resolve({ data: [], error: null }));
        return q;
      });

      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 0 });
      const minLimitQuery = capturedQueries.find(q => q.limit.mock.calls.length > 0);
      expect(minLimitQuery?.limit).toHaveBeenCalledWith(1);
      capturedQueries.length = 0;

      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 500 });
      const maxLimitQuery = capturedQueries.find(q => q.limit.mock.calls.length > 0);
      expect(maxLimitQuery?.limit).toHaveBeenCalledWith(200);
      capturedQueries.length = 0;

      await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      const defaultLimitQuery = capturedQueries.find(q => q.limit.mock.calls.length > 0);
      expect(defaultLimitQuery?.limit).toHaveBeenCalledWith(50);
    });

    it('successfully processes a batch sequentially, updating and emitting an event', async () => {
      (generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3]);
      (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });

      mockSupabase.from.mockImplementation(() => {
        const q = createMockQuery();
        capturedQueries.push(q);
        q.then.mockImplementation((resolve: any) => {
          if (q.select.mock.calls.length > 0 && q.update.mock.calls.length === 0) {
            resolve({ data: [{ id: 'item-1', content: 'test 1' }, { id: 'item-2', content: 'test 2' }], error: null });
          } else {
            resolve({ data: null, error: null });
          }
        });
        return q;
      });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 2 });
      
      expect(res.status).toBe(200);
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      
      const updateQueries = capturedQueries.filter(q => q.update.mock.calls.length > 0);
      expect(updateQueries.length).toBe(2);
      
      expect(updateQueries[0].update).toHaveBeenCalledWith(expect.objectContaining({
        embedding: [0.1, 0.2, 0.3],
        embedding_model: expect.any(String),
        embedding_updated_at: expect.anything()
      }));

      expect(emitOasisEvent).toHaveBeenCalled();
    });

    it('continues processing remaining items if generateEmbedding fails for a specific item', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      
      (generateEmbedding as jest.Mock)
        .mockRejectedValueOnce(new Error('Embedding API failed'))
        .mockResolvedValueOnce([0.5, 0.6, 0.7]);
        
      (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });

      mockSupabase.from.mockImplementation(() => {
        const q = createMockQuery();
        capturedQueries.push(q);
        q.then.mockImplementation((resolve: any) => {
          if (q.select.mock.calls.length > 0 && q.update.mock.calls.length === 0) {
            resolve({ data: [{ id: 'item-1', content: 'test 1' }, { id: 'item-2', content: 'test 2' }], error: null });
          } else {
            resolve({ data: null, error: null });
          }
        });
        return q;
      });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 2 });
      
      expect(res.status).toBe(200);
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      
      const updateQueries = capturedQueries.filter(q => q.update.mock.calls.length > 0);
      expect(updateQueries.length).toBe(1); // the first item failed; second succeeds
      expect(updateQueries[0].eq).toHaveBeenCalledWith('id', 'item-2');
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});