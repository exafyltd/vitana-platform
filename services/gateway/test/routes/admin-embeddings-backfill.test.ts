import express from 'express';
import request from 'supertest';
import backfillRouter from '../../src/routes/admin-embeddings-backfill';
import { getSupabase } from '../../src/lib/supabase';
import { generateEmbedding } from '../../src/services/embedding-service';
import { emitOasisEvent } from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.identity = { user_id: 'mock-admin', exafy_admin: true };
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

let mockRowsToReturn: any[] = [];
let mockTotalCount = 100;
let mockEmbeddedCount = 40;
let mockMissingCount = 60;

export const mockUpdate = jest.fn();
export const mockEq = jest.fn();

function createQueryBuilderMock() {
  const state: any = {
    selectArgs: null,
    isArgs: [],
    notArgs: [],
    updateArgs: null,
    limitArg: null
  };

  const builder = {
    select: jest.fn((...args) => { state.selectArgs = args; return builder; }),
    is: jest.fn((...args) => { state.isArgs.push(args); return builder; }),
    not: jest.fn((...args) => { state.notArgs.push(args); return builder; }),
    order: jest.fn((...args) => { return builder; }),
    limit: jest.fn((...args) => { state.limitArg = args[0]; return builder; }),
    update: jest.fn((...args) => { 
      state.updateArgs = args; 
      mockUpdate(...args);
      return builder; 
    }),
    eq: jest.fn((...args) => { 
      mockEq(...args);
      return builder; 
    }),
    then: function (resolve: any) {
      if (state.updateArgs) {
        resolve({ data: null, error: null });
      } else if (state.selectArgs && state.selectArgs[1]?.count === 'exact') {
        if (state.notArgs.length > 0) {
          resolve({ count: mockEmbeddedCount, data: null, error: null });
        } else if (state.isArgs.length > 0) {
          resolve({ count: mockMissingCount, data: null, error: null });
        } else {
          resolve({ count: mockTotalCount, data: null, error: null });
        }
      } else if (state.selectArgs && state.limitArg !== null) {
        resolve({ data: mockRowsToReturn, error: null });
      } else {
        resolve({ data: [], error: null });
      }
    }
  };

  return builder;
}

let app: express.Express;

beforeEach(() => {
  jest.clearAllMocks();
  
  mockRowsToReturn = [];
  mockTotalCount = 100;
  mockEmbeddedCount = 40;
  mockMissingCount = 60;
  
  app = express();
  app.use(express.json());
  app.use('/api/v1/admin/embeddings/backfill', backfillRouter);

  (getSupabase as jest.Mock).mockReturnValue({
    from: jest.fn(() => createQueryBuilderMock())
  });

  (emitOasisEvent as jest.Mock).mockResolvedValue({ ok: true });
});

describe('GET /api/v1/admin/embeddings/backfill/status', () => {
  it('returns 503 when getSupabase returns null', async () => {
    (getSupabase as jest.Mock).mockReturnValueOnce(null);
    const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
    expect([500, 503]).toContain(res.status);
    expect(res.body.ok).toBe(false);
  });

  it('returns counts and percentages correctly', async () => {
    const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        total: 100,
        embedded: 40,
        missing: 60,
        pct_embedded: 40
      }
    });
  });

  it('handles zero total items safely', async () => {
    mockTotalCount = 0;
    mockEmbeddedCount = 0;
    mockMissingCount = 0;

    const res = await request(app).get('/api/v1/admin/embeddings/backfill/status');
    expect(res.status).toBe(200);
    expect(res.body.data.pct_embedded).toBe(0);
  });
});

describe('POST /api/v1/admin/embeddings/backfill', () => {
  it('returns 503 when getSupabase returns null', async () => {
    (getSupabase as jest.Mock).mockReturnValueOnce(null);
    const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({});
    expect([500, 503]).toContain(res.status);
    expect(res.body.ok).toBe(false);
  });

  it('handles empty rows (nothing to process)', async () => {
    mockRowsToReturn = [];
    const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ batch_size: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      data: {
        processed_count: 0,
        skipped_count: 0,
        error_count: 0,
        has_more: false
      }
    });
  });

  it('executes a dry run correctly', async () => {
    mockRowsToReturn = [
      { id: '1', tenant_id: 't1', user_id: 'u1', content: 'hello' },
      { id: '2', tenant_id: 't1', user_id: 'u1', content: 'world' }
    ];
    
    const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.sample_ids).toEqual(['1', '2']);
    
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('executes successful backfill', async () => {
    mockRowsToReturn = [
      { id: '1', tenant_id: 't1', user_id: 'u1', content: 'hello' },
      { id: '2', tenant_id: 't1', user_id: 'u1', content: 'world' }
    ];
    
    (generateEmbedding as jest.Mock).mockResolvedValue({
      ok: true,
      embedding: [0.1, 0.2],
      model: 'text-embedding-3-small'
    });

    const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ batch_size: 2 });
    expect(res.status).toBe(200);
    
    expect(generateEmbedding).toHaveBeenCalledTimes(2);
    expect(generateEmbedding).toHaveBeenCalledWith('hello', 't1', 'u1');
    expect(generateEmbedding).toHaveBeenCalledWith('world', 't1', 'u1');
    
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledWith({ content_embedding: [0.1, 0.2], embedding_model: 'text-embedding-3-small' });
    expect(mockEq).toHaveBeenCalledTimes(2);
    expect(mockEq).toHaveBeenCalledWith('id', '1');
    expect(mockEq).toHaveBeenCalledWith('id', '2');

    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'memory.embeddings.updated',
      status: 'success'
    }));
  });

  it('skips items with missing content', async () => {
    mockRowsToReturn = [
      { id: '1', tenant_id: 't1', user_id: 'u1', content: '' },
      { id: '2', tenant_id: 't1', user_id: 'u1', content: ' ' },
      { id: '3', tenant_id: 't1', user_id: 'u1', content: null }
    ];
    
    const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ batch_size: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data.skipped_count).toBe(3);
    expect(res.body.data.processed_count).toBe(0);
    
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('handles execution with embedding errors', async () => {
    mockRowsToReturn = [
      { id: '1', tenant_id: 't1', user_id: 'u1', content: 'fail' }
    ];
    
    (generateEmbedding as jest.Mock).mockResolvedValue({
      ok: false,
      error: 'OpenAI error'
    });

    const res = await request(app).post('/api/v1/admin/embeddings/backfill').send({ batch_size: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.error_count).toBe(1);
    expect(res.body.data.processed_count).toBe(0);

    expect(mockUpdate).not.toHaveBeenCalled();

    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'memory.embeddings.updated',
      status: 'warning'
    }));
  });
});