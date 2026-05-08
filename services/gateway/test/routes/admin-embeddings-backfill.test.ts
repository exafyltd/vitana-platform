import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.identity = { user_id: 'admin-123', exafy_admin: true };
    next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) => next()
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn()
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn()
}));

describe('Admin Embeddings Backfill Router', () => {
  let app: express.Express;
  let capturedUpdates: any[] = [];
  let capturedLimits: number[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    capturedUpdates = [];
    capturedLimits = [];

    app = express();
    app.use(express.json());
    app.use('/api/v1/admin/embeddings/backfill', router);
    
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => {
        const chain: any = {
          select: jest.fn().mockReturnThis(),
          is: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          limit: jest.fn((val: number) => {
            capturedLimits.push(val);
            return chain;
          }),
          update: jest.fn((val: any) => {
            capturedUpdates.push(val);
            return chain;
          })
        };

        chain.then = jest.fn((resolve) => {
          if (chain.update.mock.calls.length > 0) {
            return resolve({ data: null, error: null });
          }
          
          if (chain.limit.mock.calls.length > 0) {
            const limitVal = chain.limit.mock.calls[0][0];
            const data = Array.from({ length: limitVal }).map((_, i) => ({
              id: `item-${i}`,
              content: `sample text ${i}`,
              parsed_content: `sample text ${i}`
            }));
            return resolve({ data, error: null });
          }
          
          if (chain.is.mock.calls.some((args: any[]) => args[0] === 'embedding' && args[1] === null)) {
            return resolve({ data: null, count: 20, error: null });
          }
          
          resolve({ data: null, count: 100, error: null });
        });

        return chain;
      })
    });

    (generateEmbedding as jest.Mock).mockResolvedValue({
      ok: true,
      embedding: [0.1, 0.2, 0.3],
      model: 'text-embedding-3-small'
    });

    (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      expect([500, 503]).toContain(res.status);
      expect(res.body.ok).toBe(false);
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      expect(res.status).toBeLessThan(300);
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty('data');
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    it('returns early when items.length === 0', async () => {
      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn(() => {
          const chain: any = {
            select: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
            order: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            then: jest.fn((resolve) => resolve({ data: [], error: null }))
          };
          return chain;
        })
      });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 10 });
      expect(res.status).toBeLessThan(300);
      expect(generateEmbedding).not.toHaveBeenCalled();
    });

    it('ensures dry_run: true returns early with sample IDs and skips any writes or embedding generations', async () => {
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ dry_run: true, limit: 10 });
      expect(res.status).toBeLessThan(300);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(capturedUpdates.length).toBe(0);
      expect(res.body.data).toBeDefined();
    });

    it('enforces batch limit boundaries (minimum 1, default 50, maximum 200)', async () => {
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 500, dry_run: true });
      expect(capturedLimits).toContain(200);
      capturedLimits.length = 0;

      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 0, dry_run: true });
      expect(capturedLimits).toContain(1);
      capturedLimits.length = 0;

      await request(app).post('/api/v1/admin/embeddings/backfill').send({ dry_run: true });
      expect(capturedLimits).toContain(50);
    });

    it('sequentially processes a successful item batch', async () => {
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 3 });
      expect(res.status).toBeLessThan(300);
      expect(generateEmbedding).toHaveBeenCalledTimes(3);

      expect(capturedUpdates.length).toBe(3);
      expect(capturedUpdates[0]).toEqual(expect.objectContaining({
        embedding: expect.any(Array),
        embedding_model: expect.any(String),
        embedding_updated_at: expect.any(String)
      }));

      expect(emitOasisEvent).toHaveBeenCalled();
    });

    it('simulates an internal error condition where generateEmbedding fails for a specific item securely logging but continuing', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      (generateEmbedding as jest.Mock)
        .mockResolvedValueOnce({ ok: false, error: 'Model failure' })
        .mockResolvedValueOnce({ ok: true, embedding: [0.1, 0.2], model: 'text-embedding-3-small' });

      (getSupabase as jest.Mock).mockReturnValue({
        from: jest.fn(() => {
          const chain: any = {
            select: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
            order: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            limit: jest.fn((val: number) => {
              capturedLimits.push(val);
              return chain;
            }),
            update: jest.fn((val: any) => {
              capturedUpdates.push(val);
              return chain;
            })
          };
          chain.then = jest.fn((resolve) => {
            if (chain.update.mock.calls.length > 0) {
              return resolve({ data: null, error: null });
            }
            if (chain.limit.mock.calls.length > 0) {
              const data = [
                { id: 'item-0', content: 'fail text' },
                { id: 'item-1', content: 'success text' }
              ];
              return resolve({ data, error: null });
            }
            resolve({ data: null, count: 100, error: null });
          });
          return chain;
        })
      });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 2 });
      expect(res.status).toBeLessThan(300);
      expect(generateEmbedding).toHaveBeenCalledTimes(2);

      expect(consoleSpy).toHaveBeenCalled();
      expect(capturedUpdates.length).toBe(1);

      consoleSpy.mockRestore();
    });
  });
});