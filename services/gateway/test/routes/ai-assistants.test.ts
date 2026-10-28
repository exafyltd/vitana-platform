import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import aiAssistantsRouter from '../../src/routes/ai-assistants';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/v1/integrations/ai-assistants', aiAssistantsRouter);

describe('AI Assistants Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /providers without Authorization header returns 401 via requireAuth', async () => {
    (requireAuth as jest.Mock).mockImplementation((req: Request, res: Response, next: NextFunction) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app).get('/api/v1/integrations/ai-assistants/providers');
    
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('GET /providers with valid auth passes middleware and proceeds to handler', async () => {
    (requireAuth as jest.Mock).mockImplementation((req: any, res: Response, next: NextFunction) => {
      req.identity = { 
        user_id: 'user-123', 
        tenant_id: 'tenant-123', 
        exafy_admin: false, 
        role: null,
        email: 'test@example.com'
      };
      next();
    });

    // Mock getSupabase to return null to hit the 503 DB_UNAVAILABLE early (avoids actual DB calls)
    (getSupabase as jest.Mock).mockReturnValue(null);

    const response = await request(app).get('/api/v1/integrations/ai-assistants/providers');
    
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, error: 'DB_UNAVAILABLE' });
  });
});