import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import router from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/services/embedding-service', () => ({
  generateEmbedding: jest.fn()
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn()
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: Request & { identity?: any }, res: Response, next: NextFunction) => {
    req.identity = {
      user_id: 'mock-admin',
      email: 'admin@test.com',
      tenant_id: 'tenant-1',
      exafy_admin: true,
      role: 'admin'
    };
    next();
  },
  requireExafyAdmin: (req: Request, res: Response, next: NextFunction) => {
    next();
  }
}));

describe('Admin Embeddings Backfill Router', () => {
  let app: Express;
  let currentRows: any[] = [];
  let mockUpdate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    currentRows = [];
    mockUpdate = jest.fn();

    app = express();
    app.use(express.json());
    app.use('/api/v1/admin/embeddings/backfill', router);

    const mockSupabase = {
      from: jest.fn(() => {
        let isDataSelect = false;
        let queryType = 'total';
        const chain: any = {
          select: jest.fn((cols) => {
            if (typeof cols === 'string' && cols !== '*') {
              isDataSelect = true;
            }
            return chain;
          }),
          is: jest.fn((col, val) => {
            if (col === 'embedding_vector' && val === null) queryType = 'missing';
            return chain;
          }),
          not: jest.fn((col, op, val) => {
            if (col === 'embedding_vector' && val === null) queryType = 'embedded';
            return chain;
          }),
          order: jest.fn(() => {
            isDataSelect = true;
            return chain;
          }),
          limit: jest.fn(() => {
            isDataSelect = true;
            return chain;
          }),
          update: jest.fn((payload) => {
            mockUpdate(payload);
            return {
              eq: jest.fn(() => ({
                then: (resolve: any) => resolve({ error: null })
              }))
            };
          }),
          then: (resolve: any) => {
            if (isDataSelect) {
              resolve({ data: currentRows, error: null });
            } else {
              if (queryType === 'missing') resolve({ count: 60, data: null, error: null });
              else if (queryType === 'embedded') resolve({ count: 40, data: null, error: null });
              else resolve({ count: 100, data: null, error: null });
            }
          }
        };
        return chain;
      })
    };

    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
    (generateEmbedding as jest.Mock).mockResolvedValue({ 
      ok: true, 
      embedding: [0.1, 0.2], 
      model: 'text-embedding-3-small' 
    });
    (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });
  });

  describe('GET /status', () => {
    it('should return 500/503 response if getSupabase() returns null', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body.ok).toBe(false);
    });

    it('should return correct counts and percentage', async () => {
      const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      const data = res.body.data || res.body;
      expect(data.pct_embedded).toBe(40);
    });
  });

  describe('POST /', () => {
    it('should return 500/503 response if getSupabase() returns null', async () => {
      (getSupabase as jest.Mock).mockReturnValue(null);
      const res = await request(app).post('/api/v1/admin/embeddings/backfill');
      expect(res.status).toBeGreaterThanOrEqual(500);
    });

    it('should handle empty rows correctly', async () => {
      currentRows = [];
      const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      const data = res.body.data || res.body;
      expect(data.processed_count).toBe(0);
      expect(data.has_more).toBe(false);
    });

    it('should handle dry run correctly without executing modifications', async () => {
      currentRows = [
        { id: '1', tenant_id: 't1', user_id: 'u1', content: 'test1' },
        { id: '2', tenant_id: 't1', user_id: 'u1', content: 'test2' }
      ];
      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ dry_run: true });
        
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      const data = res.body.data || res.body;
      expect(data.sample_ids).toContain('1');
      expect(data.sample_ids).toContain('2');
      
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should successfully backfill embeddings for batch', async () => {
      currentRows = [
        { id: '1', tenant_id: 't1', user_id: 'u1', content: 'test1' },
        { id: '2', tenant_id: 't1', user_id: 'u1', content: 'test2' }
      ];
      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ batch_size: 2 });
        
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      expect(generateEmbedding).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        embedding_vector: [0.1, 0.2],
        embedding_model: 'text-embedding-3-small'
      }));
      
      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
      expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'memory.embeddings.updated',
        status: 'success'
      }));
    });

    it('should skip items with empty content and handle generation errors', async () => {
      currentRows = [
        { id: '1', tenant_id: 't1', user_id: 'u1', content: '' },
        { id: '2', tenant_id: 't1', user_id: 'u1', content: 'fails' }
      ];

      (generateEmbedding as jest.Mock).mockImplementation(async (content) => {
        if (content === 'fails') return { ok: false, error: 'generation failed' };
        return { ok: true, embedding: [0.1, 0.2], model: 'text-embedding-3-small' };
      });

      const res = await request(app)
        .post('/api/v1/admin/embeddings/backfill')
        .send({ batch_size: 2 });
        
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      
      expect(emitOasisEvent).toHaveBeenCalledTimes(1);
      const eventArg = (emitOasisEvent as jest.Mock).mock.calls[0][0];
      expect(eventArg.type).toBe('memory.embeddings.updated');
      expect(eventArg.status).toBe('warning');
      
      const errorCount = eventArg.error_count ?? eventArg.metadata?.error_count;
      const skippedCount = eventArg.skipped_count ?? eventArg.metadata?.skipped_count;
      expect(errorCount).toBe(1);
      expect(skippedCount).toBe(1);
    });
  });
});