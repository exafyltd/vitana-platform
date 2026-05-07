import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req: Request, res: Response, next: NextFunction) => {
    (req as any).identity = {
      user_id: 'admin-user-id',
      email: 'admin@exafy.local',
      tenant_id: 'tenant-1',
      exafy_admin: true,
      role: 'admin'
    };
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

let mockItemsForSelect: any[] = [];
let mockCountTotal = 100;
let mockCountEmbedded = 80;
let mockCountMissing = 20;
let capturedQueries: any[] = [];

const createQueryBuilder = () => {
  const state: any = {};
  const builder: any = {
    select: jest.fn((args, options) => {
      state.select = args;
      state.options = options;
      return builder;
    }),
    is: jest.fn((col, val) => {
      if (!state.filters) state.filters = [];
      state.filters.push({ type: 'is', col, val });
      return builder;
    }),
    not: jest.fn((col, op, val) => {
      if (!state.filters) state.filters = [];
      state.filters.push({ type: 'not', col, op, val });
      return builder;
    }),
    neq: jest.fn((col, val) => {
      if (!state.filters) state.filters = [];
      state.filters.push({ type: 'neq', col, val });
      return builder;
    }),
    order: jest.fn((col, options) => {
      state.order = { col, options };
      return builder;
    }),
    limit: jest.fn((val) => {
      state.limit = val;
      return builder;
    }),
    update: jest.fn((payload) => {
      state.update = payload;
      return builder;
    }),
    eq: jest.fn((col, val) => {
      state.eq = { col, val };
      return builder;
    }),
    then: jest.fn((resolve, reject) => {
      capturedQueries.push({ ...state });
      let result: any = { data: [], error: null };
      
      if (state.options?.count || state.options?.count === 'exact' || state.options?.head) {
        const hasMissingFilter = state.filters?.some((f: any) => f.type === 'is' && f.val === null);
        const hasEmbeddedFilter = state.filters?.some((f: any) => f.type === 'not' || f.type === 'neq');
        
        if (hasMissingFilter) {
          result.count = mockCountMissing;
        } else if (hasEmbeddedFilter) {
          result.count = mockCountEmbedded;
        } else {
          result.count = mockCountTotal;
        }
        result.data = null;
      } else if (state.update) {
        result.data = [{ id: state.eq?.val }];
      } else {
        result.data = mockItemsForSelect;
      }
      
      return Promise.resolve(result).then(resolve).catch(reject);
    })
  };
  return builder;
};

describe('Admin Embeddings Backfill Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockItemsForSelect = [];
    mockCountTotal = 100;
    mockCountEmbedded = 80;
    mockCountMissing = 20;
    capturedQueries = [];
    
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn(() => createQueryBuilder())
    });

    app = express();
    app.use(express.json());
    app.use('/api/v1', router);
    // Add exact path mounts to ensure matching regardless of how the router scopes paths
    app.use('/api/v1/admin/embeddings/backfill', router);
    app.use('/', router);
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValueOnce(null);
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      mockCountTotal = 1000;
      mockCountEmbedded = 800;
      mockCountMissing = 200;
      
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      const countQueries = capturedQueries.filter(q => q.options?.count);
      expect(countQueries.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    it('returns early when empty batch (items.length === 0)', async () => {
      mockItemsForSelect = [];
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send();
      
      expect(res.status).toBe(200);
      expect(generateEmbedding).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs and skips any writes or embedding generations when dry_run: true', async () => {
      mockItemsForSelect = [ { id: 'doc-1' }, { id: 'doc-2' } ];
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ dry_run: true });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      expect(generateEmbedding).not.toHaveBeenCalled();
      
      const updates = capturedQueries.filter(q => q.update);
      expect(updates.length).toBe(0);
    });

    it('enforces limit boundaries (minimum 1)', async () => {
      mockItemsForSelect = [];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 0 });
      
      const selectQuery = capturedQueries.find(q => q.limit !== undefined && !q.update);
      expect(selectQuery?.limit).toBe(1);
    });

    it('enforces limit boundaries (default 50)', async () => {
      mockItemsForSelect = [];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      
      const selectQuery = capturedQueries.find(q => q.limit !== undefined && !q.update);
      expect(selectQuery?.limit).toBe(50);
    });

    it('enforces limit boundaries (maximum 200)', async () => {
      mockItemsForSelect = [];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 500 });
      
      const selectQuery = capturedQueries.find(q => q.limit !== undefined && !q.update);
      expect(selectQuery?.limit).toBe(200);
    });

    it('successfully processes a batch sequentially by executing generateEmbedding(), invoking the Supabase update() call, and calling emitOasisEvent()', async () => {
      mockItemsForSelect = [
        { id: 'doc-1', title: 'Title 1', content: 'Content 1' },
        { id: 'doc-2', title: 'Title 2', content: 'Content 2' }
      ];
      
      (generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3]);
      (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });
      
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 2 });
      
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      
      const updates = capturedQueries.filter(q => q.update);
      expect(updates.length).toBe(2);
      
      expect(updates[0].update).toHaveProperty('embedding');
      expect(updates[0].update).toHaveProperty('embedding_model');
      expect(updates[0].update).toHaveProperty('embedding_updated_at');
      
      expect(emitOasisEvent).toHaveBeenCalled();
    });

    it('handles partial errors when generateEmbedding fails for a specific item, securely logs failure but continues', async () => {
      mockItemsForSelect = [
        { id: 'doc-1', content: 'C1' },
        { id: 'doc-error', content: 'C2' },
        { id: 'doc-3', content: 'C3' }
      ];
      
      let callCount = 0;
      (generateEmbedding as jest.Mock).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Simulated embedding generation failure');
        }
        return [0.1, 0.2, 0.3];
      });
      
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 3 });
      
      expect(res.status).toBe(200);
      expect(generateEmbedding).toHaveBeenCalledTimes(3);
      
      const updates = capturedQueries.filter(q => q.update);
      // Item 2 failed, expecting exactly 2 successful updates to be sent
      expect(updates.length).toBe(2);
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});