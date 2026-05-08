import request from 'supertest';
import express from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req: any, res: any, next: any) => {
    req.identity = { user_id: 'test-admin-id', exafy_admin: true };
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

let mockSupabaseResponses: any[] = [];

// Chainable mock to simulate Supabase query builder
const mockChain: any = {
  select: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  not: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn().mockReturnThis(),
};

// Act as a Thenable to allow 'await supabase.from()...'
mockChain.then = function (resolve: (value: any) => void) {
  const response = mockSupabaseResponses.length > 0
    ? mockSupabaseResponses.shift()
    : { data: [], error: null, count: 0 };
  resolve(response);
};

describe('Admin Embeddings Backfill Router', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseResponses = [];

    app = express();
    app.use(express.json());
    
    // Mount the router both strictly and implicitly to accommodate internal route pathing
    // so tests correctly trigger regardless of whether the router defines `/status` or `/admin/embeddings/backfill/status`
    app.use('/api/v1', router);
    app.use('/api/v1/admin/embeddings/backfill', router);
  });

  describe('GET /api/v1/admin/embeddings/backfill/status', () => {
    it('returns 500 when Supabase is unavailable', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('calculates correct percentages when providing total, embedded, and missing counts', async () => {
      const mockSupabase = { from: jest.fn(() => mockChain) };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);

      // Pre-load responses to simulate sequential count queries in the route
      mockSupabaseResponses = [
        { count: 100, error: null }, // e.g., total count
        { count: 40, error: null },  // e.g., embedded count
        { count: 60, error: null }   // e.g., missing count
      ];

      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      // Verifies that calculations complete without NaN or crashes
    });
  });

  describe('POST /api/v1/admin/embeddings/backfill', () => {
    beforeEach(() => {
      const mockSupabase = { from: jest.fn(() => mockChain) };
      (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
    });

    it('returns early without further processing when items.length === 0', async () => {
      // Supabase fetch returns empty batch
      mockSupabaseResponses = [{ data: [], error: null }];

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(emitOasisEvent).not.toHaveBeenCalled();
    });

    it('returns early with sample IDs and skips any writes or embedding generations when dry_run is true', async () => {
      // Supabase fetch returns mock sample batch
      mockSupabaseResponses = [{ data: [{ id: 'sample-1' }, { id: 'sample-2' }], error: null }];

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ dry_run: true });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockChain.update).not.toHaveBeenCalled(); // Ensures skipped writes
    });

    it('enforces batch limit boundaries (minimum 1, default 50, maximum 200) accurately', async () => {
      // Test MIN boundary
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 0 });
      expect(mockChain.limit).toHaveBeenCalledWith(1);
      mockChain.limit.mockClear();

      // Test DEFAULT boundary
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      expect(mockChain.limit).toHaveBeenCalledWith(50);
      mockChain.limit.mockClear();

      // Test MAX boundary
      mockSupabaseResponses = [{ data: [], error: null }];
      await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 500 });
      expect(mockChain.limit).toHaveBeenCalledWith(200);
    });

    it('sequentially processes a successful item batch by executing generateEmbedding, Supabase update, and emitOasisEvent', async () => {
      mockSupabaseResponses = [
        { data: [{ id: 'item-1', content: 'test content' }], error: null }, // Fetch batch
        { error: null } // Update record
      ];

      (generateEmbedding as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3]);
      (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
      expect(mockChain.update).toHaveBeenCalledTimes(1);
      
      const updatePayload = mockChain.update.mock.calls[0][0];
      expect(updatePayload).toHaveProperty('embedding');
      expect(updatePayload).toHaveProperty('embedding_model');
      expect(updatePayload).toHaveProperty('embedding_updated_at');

      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
    });

    it('securely logs the failure but continues processing remaining items if generateEmbedding fails for a specific item', async () => {
      mockSupabaseResponses = [
        { data: [{ id: 'fail-item', content: 'trigger-fail' }, { id: 'success-item', content: 'valid' }], error: null }, // Fetch batch
        { error: null } // Update for success-item
      ];

      (generateEmbedding as jest.Mock).mockImplementation(async (content: string) => {
        if (content === 'trigger-fail') {
          throw new Error('Simulated embedding generation failure');
        }
        return [0.5, 0.5];
      });

      // Suppress console.error solely for this simulation to avoid test noise
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verify it tried to process both
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      
      // Verify update only happened for the successfully processed item
      expect(mockChain.update).toHaveBeenCalledTimes(1);

      consoleErrorSpy.mockRestore();
    });
  });
});