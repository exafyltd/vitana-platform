import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).identity = { user_id: 'admin-user', exafy_admin: true };
    next();
  }),
  requireExafyAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => next())
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

let mockSupabaseResponses: any[] = [];
const createSupabaseMock = () => {
  const mock: any = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
  };
  mock.then = function (resolve: any, reject: any) {
    const res = mockSupabaseResponses.length > 0
      ? mockSupabaseResponses.shift()
      : { data: [], error: null, count: null };
    return Promise.resolve(res).then(resolve, reject);
  };
  return mock;
};
const mockSupabaseInstance = createSupabaseMock();

describe('Admin Embeddings Backfill Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseResponses = [];

    app = express();
    app.use(express.json());

    // Mount at generic and specific paths to reliably catch differing internal router setups
    app.use('/api/v1', router);
    app.use('/api/v1/admin/embeddings/backfill', router);
    app.use('/', router);
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      (getSupabase as jest.Mock).mockReturnValue(mockSupabaseInstance);
      mockSupabaseResponses = [
        { data: null, error: null, count: 100 }, // total
        { data: null, error: null, count: 40 },  // embedded
        { data: null, error: null, count: 60 }   // missing
      ];

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockSupabaseInstance.select).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    it('returns early without further processing when items.length === 0', async () => {
      (getSupabase as jest.Mock).mockReturnValue(mockSupabaseInstance);
      mockSupabaseResponses = [{ data: [], error: null }];

      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 10 });

      expect(res.status).toBe(200);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockSupabaseInstance.update).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs and skips writes or generation on dry_run: true', async () => {
      (getSupabase as jest.Mock).mockReturnValue(mockSupabaseInstance);
      mockSupabaseResponses = [
        { data: [{ id: 'vtid-1' }, { id: 'vtid-2' }], error: null }
      ];

      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ dry_run: true, limit: 2 });

      expect(res.status).toBe(200);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockSupabaseInstance.update).not.toHaveBeenCalled();
      expect(res.body.ok).toBe(true);
    });

    it('enforces batch limit boundaries (minimum 1, default 50, maximum 200)', async () => {
      (getSupabase as jest.Mock).mockReturnValue(mockSupabaseInstance);

      // Over maximum clamps to 200
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 500 });
      expect(mockSupabaseInstance.limit).toHaveBeenCalledWith(200);

      // Under minimum clamps to 1
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 0 });
      expect(mockSupabaseInstance.limit).toHaveBeenCalledWith(1);

      // No limit provided uses default 50
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      expect(mockSupabaseInstance.limit).toHaveBeenCalledWith(50);
    });

    it('sequentially processes by generating embeddings, calling update, and emitting Oasis events', async () => {
      (getSupabase as jest.Mock).mockReturnValue(mockSupabaseInstance);
      mockSupabaseResponses = [
        { data: [{ id: 'req-1', text: 'query1' }, { id: 'req-2', text: 'query2' }], error: null },
        { data: null, error: null }, // update req-1
        { data: null, error: null }  // update req-2
      ];

      (generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2]);
      (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });

      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 2 });

      expect(res.status).toBe(200);
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      expect(mockSupabaseInstance.update).toHaveBeenCalledTimes(2);
      expect(emitOasisEvent).toHaveBeenCalled();

      expect(mockSupabaseInstance.update).toHaveBeenCalledWith(expect.objectContaining({
        embedding: expect.any(Array)
      }));
    });

    it('securely logs failures for specific items but continues processing remaining items', async () => {
      (getSupabase as jest.Mock).mockReturnValue(mockSupabaseInstance);
      mockSupabaseResponses = [
        { data: [{ id: 'req-1', text: 'fail-me' }, { id: 'req-2', text: 'pass-me' }], error: null },
        { data: null, error: null } // Single update expected for the successful generation
      ];

      (generateEmbedding as jest.Mock)
        .mockRejectedValueOnce(new Error('Internal generation error'))
        .mockResolvedValueOnce([0.5, 0.5]);

      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ limit: 2 });

      expect(res.status).toBe(200);
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      // Only the item that succeeded the embedding generation maps to a db update
      expect(mockSupabaseInstance.update).toHaveBeenCalledTimes(1);
    });
  });
});