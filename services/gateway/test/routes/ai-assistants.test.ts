import express from 'express';
import request from 'supertest';
import aiAssistantsRouter from '../../../src/routes/ai-assistants';
import { requireAuth } from '../../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../../src/lib/supabase';

jest.mock('../../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(),
}));

jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

describe('AI Assistants Router - Auth', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/v1/integrations/ai-assistants', aiAssistantsRouter);
  });

  it('rejects requests without authentication (401)', async () => {
    // Mock requireAuth to replicate standard behavior for unauthenticated requests
    (requireAuth as jest.Mock).mockImplementation((req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      }
      next();
    });

    const response = await request(app).get('/api/v1/integrations/ai-assistants/providers');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('allows authenticated requests through the standard middleware', async () => {
    // Mock requireAuth to pass and set req.identity
    (requireAuth as jest.Mock).mockImplementation((req, res, next) => {
      req.identity = { user_id: 'test-user-id', tenant_id: 'test-tenant-id' };
      next();
    });

    // Force a known failure state downstream so we know handler logic executed
    (getSupabase as jest.Mock).mockReturnValue(null);

    const response = await request(app)
      .get('/api/v1/integrations/ai-assistants/providers')
      .set('Authorization', 'Bearer valid_mock_token');

    // The handler returns a 503 DB_UNAVAILABLE if getSupabase() returns null
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: 'DB_UNAVAILABLE' });
  });
});