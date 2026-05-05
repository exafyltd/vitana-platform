import request from 'supertest';
import express from 'express';
import settingsRouter from '../../src/routes/settings';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.identity = {
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      email: 'test@example.com',
      exafy_admin: false,
      role: 'user'
    };
    next();
  }
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/api/v1/settings', settingsRouter);

describe('Settings Profile Integration', () => {
  let mockSupabase: any;

  beforeEach(() => {
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn()
    };
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('updates first name with provenanceSource user_stated_via_settings', async () => {
    mockSupabase.single.mockResolvedValue({ data: { id: 'fact-1' }, error: null });

    const response = await request(app)
      .patch('/api/v1/settings/profile')
      .send({ firstName: 'Bob' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    expect(mockSupabase.from).toHaveBeenCalledWith('memory_facts');
    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        tenant_id: 'tenant-1',
        fact_type: 'user_first_name',
        fact_value: 'Bob',
        provenance_source: 'user_stated_via_settings'
      }),
      expect.any(Object)
    );
  });

  it('updates nickname with provenanceSource user_stated_via_settings', async () => {
    mockSupabase.single.mockResolvedValue({ data: { id: 'fact-2' }, error: null });

    const response = await request(app)
      .patch('/api/v1/settings/profile')
      .send({ nickname: 'Bobby' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    expect(mockSupabase.from).toHaveBeenCalledWith('memory_facts');
    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        tenant_id: 'tenant-1',
        fact_type: 'user_nickname',
        fact_value: 'Bobby',
        provenance_source: 'user_stated_via_settings'
      }),
      expect.any(Object)
    );
  });

  it('returns 500 when supabase throws an error', async () => {
    mockSupabase.single.mockResolvedValue({ data: null, error: { message: 'identity_locked' } });

    const response = await request(app)
      .patch('/api/v1/settings/profile')
      .send({ firstName: 'Bob' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, error: 'identity_locked' });
  });

  it('returns 400 for invalid body', async () => {
    const response = await request(app)
      .patch('/api/v1/settings/profile')
      .send({ firstName: 123 }); // invalid type

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid body' });
  });
});