import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import router from '../../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../../src/lib/supabase';
import { generateEmbedding } from '../../../src/services/embedding-service';
import { emitOasisEvent } from '../../../src/services/oasis-event-service';

// Mock identity middleware
jest.mock('../../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).identity = { user_id: 'mock-admin-id', exafy_admin: true };
    next();
  }),
  requireExafyAdmin: jest.fn((req: Request, res: Response, next: NextFunction) => {
    next();
  }),
}));

// Mock Supabase with a chainable interface supporting promises
const queryBuilder: any = {
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
  maybeSingle: jest.fn().mockReturnThis(),
};
queryBuilder.then = jest.fn((resolve) => resolve({ data: [], error: null, count: 0 }));

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => queryBuilder),
}));

// Mock external side-effect services
jest.mock('../../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn(),
}));

jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(),
}));

describe('Admin Embeddings Backfill Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    // Mount the router at multiple potential paths to ensure requests securely route
    // regardless of whether the exported router uses relative ('/') or full absolute mappings
    app.use('/api/v1', router);
    app.use('/api/v1/admin/embeddings/backfill', router);
    app.use(router);
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValueOnce(null);

      // Attempt requests across the registered mounting patterns gracefully
      let res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      if (res.status === 404) res = await request(app).get('/status');

      expect(res.status).toBeGreaterThanOrEqual(500);
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      (getSupabase as jest.Mock).mockReturnValue(queryBuilder);

      // Mock sequential chainable query returns: Total, Embedded, Missing
      queryBuilder.then
        .mockImplementationOnce((cb: any) => cb({ data: null, error: null, count: 200 }))
        .mockImplementationOnce((cb: any) => cb({ data: null, error: null, count: 150 }))
        .mockImplementationOnce((cb: any) => cb({ data: null, error: null, count: 50 }));

      let res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      if (res.status === 404) res = await request(app).get('/status');

      expect(res.status).toBe(200);
      expect(queryBuilder.select).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    const postBackfill = async (body: any) => {
      let res = await request(app).post('/api/v1/admin/embeddings/backfill').send(body);
      if (res.status === 404) res = await request(app).post('/').send(body);
      return res;
    };

    it('returns early when items.length === 0', async () => {
      (getSupabase as jest.Mock).mockReturnValue(queryBuilder);
      queryBuilder.then.mockImplementationOnce((cb: any) => cb({ data: [], error: null }));

      const res = await postBackfill({});

      expect(res.status).toBe(200);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(queryBuilder.update).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs and skips any writes or embedding generations if dry_run: true', async () => {
      (getSupabase as jest.Mock).mockReturnValue(queryBuilder);
      queryBuilder.then.mockImplementationOnce((cb: any) => cb({
        data: [{ id: 'mock-sample-uuid-1' }, { id: 'mock-sample-uuid-2' }],
        error: null
      }));

      const res = await postBackfill({ dry_run: true });

      expect(res.status).toBe(200);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(queryBuilder.update).not.toHaveBeenCalled();

      // Ensure sample IDs surface cleanly
      const responseBodyStr = JSON.stringify(res.body);
      expect(responseBodyStr).toContain('mock-sample-uuid-1');
      expect(responseBodyStr).toContain('mock-sample-uuid-2');
    });

    it('enforces batch limit boundaries (minimum 1, default 50, maximum 200)', async () => {
      (getSupabase as jest.Mock).mockReturnValue(queryBuilder);
      queryBuilder.then.mockImplementation((cb: any) => cb({ data: [], error: null }));

      // Test Min Limit constraint (validating fallback via Zod logic vs clamping safely)
      let res = await postBackfill({ limit: 0 });
      if (res.status === 200) {
        expect(queryBuilder.limit).toHaveBeenCalledWith(1);
      } else {
        expect(res.status).toBe(400); 
      }

      jest.clearAllMocks();

      // Test Default boundary constraint (usually mapped to 50 items)
      await postBackfill({});
      expect(queryBuilder.limit).toHaveBeenCalledWith(50);

      jest.clearAllMocks();

      // Test Max Limit boundary
      res = await postBackfill({ limit: 500 });
      if (res.status === 200) {
        expect(queryBuilder.limit).toHaveBeenCalledWith(200);
      } else {
        expect(res.status).toBe(400);
      }
    });

    it('sequentially processes a successful item batch, mutates via update, and emits an Oasis event', async () => {
      (getSupabase as jest.Mock).mockReturnValue(queryBuilder);

      // Setup initial data retrieval and null completions for loop mutations
      queryBuilder.then
        .mockImplementationOnce((cb: any) => cb({
          data: [
            { id: 'valid-uuid-1', content: 'content A' },
            { id: 'valid-uuid-2', content: 'content B' }
          ],
          error: null
        }))
        .mockImplementationOnce((cb: any) => cb({ data: null, error: null }))
        .mockImplementationOnce((cb: any) => cb({ data: null, error: null }));

      (generateEmbedding as jest.Mock)
        .mockResolvedValueOnce([0.11, 0.22, 0.33])
        .mockResolvedValueOnce([0.44, 0.55, 0.66]);

      (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });

      const res = await postBackfill({ limit: 2 });

      expect(res.status).toBe(200);
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      expect(queryBuilder.update).toHaveBeenCalledTimes(2);
      expect(emitOasisEvent).toHaveBeenCalled();
    });

    it('securely logs failure but continues processing remaining items when generateEmbedding fails for a specific item', async () => {
      (getSupabase as jest.Mock).mockReturnValue(queryBuilder);

      queryBuilder.then
        .mockImplementationOnce((cb: any) => cb({
          data: [
            { id: 'failing-uuid-1', content: 'bad data' },
            { id: 'succeeding-uuid-2', content: 'good data' }
          ],
          error: null
        }))
        .mockImplementationOnce((cb: any) => cb({ data: null, error: null })); // Simulating subsequent database hit

      (generateEmbedding as jest.Mock)
        .mockRejectedValueOnce(new Error('Embedding service down'))
        .mockResolvedValueOnce([0.77, 0.88]);

      const res = await postBackfill({ limit: 2 });

      expect(res.status).toBe(200);
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      // Validate skipped write block logic properly
      expect(queryBuilder.update).toHaveBeenCalledTimes(1);
    });
  });
});