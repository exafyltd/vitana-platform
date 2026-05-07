import request from 'supertest';
import express from 'express';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';

// Mock requireAuth to simulate actual middleware behavior for the purpose of integration testing
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    // Simulate population of standard identity claims when valid auth is provided
    req.identity = {
      user_id: 'test-user-id',
      tenant_id: 'test-tenant-id',
      email: 'test@example.com',
      exafy_admin: false,
      role: null
    };
    next();
  })
}));

// Mock Supabase to ensure handlers don't make real DB calls
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => null)
}));

import aiAssistantsRouter from '../../src/routes/ai-assistants';

const app = express();
app.use(express.json());
app.use('/api/v1/integrations/ai-assistants', aiAssistantsRouter);

describe('AI Assistants Router Authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthenticated requests to GET /providers', async () => {
    const res = await request(app).get('/api/v1/integrations/ai-assistants/providers');
    
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(requireAuth).toHaveBeenCalled();
  });

  it('allows authenticated requests to proceed to the handler', async () => {
    // With getSupabase mocked to return null, the handler will correctly return 503
    const res = await request(app)
      .get('/api/v1/integrations/ai-assistants/providers')
      .set('Authorization', 'Bearer valid-fake-token');
    
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'DB_UNAVAILABLE' });
    expect(requireAuth).toHaveBeenCalled();
  });
});