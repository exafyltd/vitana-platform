import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import settingsRouter from '../../../src/routes/settings';
import { getSupabase } from '../../../src/lib/supabase';
import { AuthenticatedRequest } from '../../../src/middleware/auth-supabase-jwt';

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    req.identity = { 
      user_id: 'test-user-123',
      email: 'test@example.com',
      tenant_id: null,
      exafy_admin: false,
      role: null
    };
    next();
  }
}));

const app = express();
app.use(express.json());
app.use('/api/v1/settings', settingsRouter);

describe('Settings Profile Integration', () => {
  let mockUpsert: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsert = jest.fn().mockResolvedValue({ error: null });
    
    (getSupabase as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({
        upsert: mockUpsert
      })
    });
  });

  it('should return 400 for an invalid payload', async () => {
    const res = await request(app)
      .patch('/api/v1/settings/profile')
      .send({ first_name: 123 }); // integer instead of string

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('invalid payload');
  });

  it('should update profile and write memory facts with correct provenance_source', async () => {
    const res = await request(app)
      .patch('/api/v1/settings/profile')
      .send({
        first_name: 'Bob',
        nickname: 'Bobby'
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'test-user-123',
        fact_key: 'user_first_name',
        fact_value: 'Bob',
        provenance_source: 'user_stated_via_settings'
      }),
      expect.any(Object)
    );
    
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'test-user-123',
        fact_key: 'user_nickname',
        fact_value: 'Bobby',
        provenance_source: 'user_stated_via_settings'
      }),
      expect.any(Object)
    );
  });
});