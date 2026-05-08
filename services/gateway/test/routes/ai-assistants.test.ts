import express from 'express';
import request from 'supertest';
import router from '../../src/routes/ai-assistants';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

// Mock dependencies
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn()
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/api/v1/integrations/ai-assistants', router);

describe('AI Assistants Route Auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthenticated requests directly in middleware', async () => {
    // Simulate requireAuth intercepting a request lacking valid credentials
    (requireAuth as jest.Mock).mockImplementation((req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      }
      next();
    });

    const res = await request(app).get('/api/v1/integrations/ai-assistants/providers');
    
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('allows authenticated requests and processes the handler logic', async () => {
    // Simulate requireAuth succeeding and injecting context
    (requireAuth as jest.Mock).mockImplementation((req, res, next) => {
      req.identity = { user_id: 'user_123', tenant_id: 'tenant_456' };
      next();
    });

    // Mock DB unavailability to cleanly assert we reached handler logic after auth
    (getSupabase as jest.Mock).mockReturnValue(null);

    const res = await request(app)
      .get('/api/v1/integrations/ai-assistants/providers')
      .set('Authorization', 'Bearer valid.jwt.token');
    
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'DB_UNAVAILABLE' });
  });
});