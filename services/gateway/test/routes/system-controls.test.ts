import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as supabaseLib from '../../src/lib/supabase';
import * as systemControlsService from '../../src/services/system-controls';

// Mock auth middleware to bypass auth entirely for these tests
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => next(),
}));

const app = express();
app.use(express.json());
app.use('/api/v1/system-controls', systemControlsRouter);

describe('System Controls API Route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 503 if no supabase client is returned', async () => {
    jest.spyOn(supabaseLib, 'getSupabase').mockReturnValue(null);
    const res = await request(app).get('/api/v1/system-controls/some_key');
    
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('no supabase');
  });

  it('returns 200 and data when service succeeds', async () => {
    const mockClient = {} as any;
    jest.spyOn(supabaseLib, 'getSupabase').mockReturnValue(mockClient);
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue({
      ok: true,
      data: { key: 'some_key', enabled: true }
    });

    const res = await request(app).get('/api/v1/system-controls/some_key');
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.key).toBe('some_key');
  });

  it('returns 404 when service returns Not found error', async () => {
    const mockClient = {} as any;
    jest.spyOn(supabaseLib, 'getSupabase').mockReturnValue(mockClient);
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue({
      ok: false,
      error: 'Not found'
    });

    const res = await request(app).get('/api/v1/system-controls/missing_key');
    
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('system control not found');
  });

  it('returns 500 when service returns any other error', async () => {
    const mockClient = {} as any;
    jest.spyOn(supabaseLib, 'getSupabase').mockReturnValue(mockClient);
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue({
      ok: false,
      error: 'DB connection failed'
    });

    const res = await request(app).get('/api/v1/system-controls/err_key');
    
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('DB connection failed');
  });
});