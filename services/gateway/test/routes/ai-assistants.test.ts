import express from 'express';
import request from 'supertest';
import aiAssistantsRouter from '../../src/routes/ai-assistants';
import { getSupabase } from '../../src/lib/supabase';

// Mock dependencies
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn()
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    // Simulate valid parsed token payload populating req.identity
    req.identity = {
      user_id: 'test-user-123',
      tenant_id: 'test-tenant-123',
      exafy_admin: false,
      email: null,
      role: null
    };
    next();
  })
}));

describe('AI Assistants Router Authentication', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Mount the router under the standard path
    app.use('/api/v1/integrations/ai-assistants', aiAssistantsRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 UNAUTHENTICATED when Authorization header is missing', async () => {
    const response = await request(app).get('/api/v1/integrations/ai-assistants/providers');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('should proceed to route handler and return 503 DB_UNAVAILABLE when authenticated but db is down', async () => {
    // Mock getSupabase to return null to simulate DB unavailable,
    // which proves we successfully passed the auth middleware and hit the route handler logic.
    (getSupabase as jest.Mock).mockReturnValue(null);

    const response = await request(app)
      .get('/api/v1/integrations/ai-assistants/providers')
      .set('Authorization', 'Bearer valid-dummy-token');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: 'DB_UNAVAILABLE' });
  });
});