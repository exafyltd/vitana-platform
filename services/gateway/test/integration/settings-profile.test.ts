import request from 'supertest';
import express from 'express';
import settingsRouter from '../../../src/routes/settings';
import { getSupabase } from '../../../src/lib/supabase';

// Mock auth middleware
jest.mock('../../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    req.identity = {
      user_id: 'test-user-id',
      tenant_id: 'test-tenant-id',
      email: 'test@example.com',
      exafy_admin: false,
      role: 'user'
    };
    next();
  })
}));

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

describe('PATCH /settings/profile', () => {
  let app: express.Express;
  let mockUpsert: jest.Mock;
  let mockSupabase: any;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/settings', settingsRouter);

    mockUpsert = jest.fn().mockResolvedValue({ error: null });
    mockSupabase = {
      from: jest.fn().mockReturnValue({
        upsert: mockUpsert
      })
    };
    (getSupabase as jest.Mock).mockReturnValue(mockSupabase);
  });

  it('writes user_first_name memory fact with user_stated_via_settings provenance', async () => {
    const response = await request(app)
      .patch('/settings/profile')
      .send({ first_name: 'Bob' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    
    expect(mockSupabase.from).toHaveBeenCalledWith('memory_facts');
    expect(mockUpsert).toHaveBeenCalledWith(
      {
        user_id: 'test-user-id',
        tenant_id: 'test-tenant-id',
        fact_key: 'user_first_name',
        fact_value: 'Bob',
        provenance_source: 'user_stated_via_settings'
      },
      { onConflict: 'user_id, fact_key' }
    );
  });

  it('writes user_nickname memory fact with user_stated_via_settings provenance', async () => {
    const response = await request(app)
      .patch('/settings/profile')
      .send({ nickname: 'Bobby' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    
    expect(mockSupabase.from).toHaveBeenCalledWith('memory_facts');
    expect(mockUpsert).toHaveBeenCalledWith(
      {
        user_id: 'test-user-id',
        tenant_id: 'test-tenant-id',
        fact_key: 'user_nickname',
        fact_value: 'Bobby',
        provenance_source: 'user_stated_via_settings'
      },
      { onConflict: 'user_id, fact_key' }
    );
  });

  it('returns 400 for invalid payload', async () => {
    const response = await request(app)
      .patch('/settings/profile')
      .send({ first_name: 123 }); // Expecting a string but sent a number

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
  
  it('handles write failure', async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: 'identity_locked' } });

    const response = await request(app)
      .patch('/settings/profile')
      .send({ first_name: 'Bob' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false, error: 'identity_locked' });
  });
});