/**
 * BOOTSTRAP-AWS-STAGING-VALIDATION: covers auth (internal bypass, admin JWT,
 * non-admin JWT, unauthenticated) and the happy/error paths of the temporary
 * AI Studio ListModels debug proxy.
 */

import request from 'supertest';
import express, { Express } from 'express';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(),
}));

import debugAiStudioModelsRouter from '../../src/routes/debug-ai-studio-models';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';

describe('BOOTSTRAP-AWS-STAGING-VALIDATION: debug-ai-studio-models route', () => {
  let app: Express;
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, GATEWAY_INTERNAL_TOKEN: 'test-internal-token', GOOGLE_GEMINI_API_KEY: 'test-api-key' };
    app = express();
    app.use(express.json());
    app.use('/api/v1', debugAiStudioModelsRouter);
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('allows access via the internal bypass header, skipping JWT auth entirely', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'models/gemini-2.0-flash-live-001', supportedGenerationMethods: ['bidiGenerateContent'] }] }),
    }) as any;

    const response = await request(app)
      .get('/api/v1/debug/ai-studio-models')
      .set('X-Gateway-Internal', 'test-internal-token');

    expect(response.status).toBe(200);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(response.body.ok).toBe(true);
  });

  it('rejects a mismatched internal bypass header and falls through to JWT auth (which is unauthenticated here)', async () => {
    (requireAuth as jest.Mock).mockImplementation((_req, res: express.Response) => {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    });

    const response = await request(app)
      .get('/api/v1/debug/ai-studio-models')
      .set('X-Gateway-Internal', 'wrong-token');

    expect(response.status).toBe(401);
    expect(requireAuth).toHaveBeenCalled();
  });

  it('rejects an authenticated non-admin identity with 403', async () => {
    (requireAuth as jest.Mock).mockImplementation((req: any, _res, next) => {
      req.identity = { user_id: 'u1', email: 'u@test.com', tenant_id: 't1', exafy_admin: false, role: 'authenticated' };
      next();
    });

    const response = await request(app).get('/api/v1/debug/ai-studio-models');

    expect(response.status).toBe(403);
  });

  it('allows an authenticated exafy_admin identity and proxies ListModels, filtering to bidi-capable models', async () => {
    (requireAuth as jest.Mock).mockImplementation((req: any, _res, next) => {
      req.identity = { user_id: 'admin1', email: 'admin@test.com', tenant_id: 't1', exafy_admin: true, role: 'authenticated' };
      next();
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.0-flash-live-001', supportedGenerationMethods: ['bidiGenerateContent'] },
          { name: 'models/gemini-2.0-flash-exp', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    }) as any;

    const response = await request(app).get('/api/v1/debug/ai-studio-models?version=v1alpha');

    expect(response.status).toBe(200);
    expect(response.body.api_version).toBe('v1alpha');
    expect(response.body.total_models).toBe(2);
    expect(response.body.live_capable).toEqual([
      { name: 'models/gemini-2.0-flash-live-001', methods: ['bidiGenerateContent'] },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://generativelanguage.googleapis.com/v1alpha/models?key=test-api-key'),
    );
  });

  it('returns 500 when GOOGLE_GEMINI_API_KEY is not configured', async () => {
    delete process.env.GOOGLE_GEMINI_API_KEY;
    (requireAuth as jest.Mock).mockImplementation((req: any, _res, next) => {
      req.identity = { user_id: 'admin1', email: 'admin@test.com', tenant_id: 't1', exafy_admin: true, role: 'authenticated' };
      next();
    });

    const response = await request(app).get('/api/v1/debug/ai-studio-models');

    expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false);
  });

  it('passes through Google error responses with their status code', async () => {
    (requireAuth as jest.Mock).mockImplementation((req: any, _res, next) => {
      req.identity = { user_id: 'admin1', email: 'admin@test.com', tenant_id: 't1', exafy_admin: true, role: 'authenticated' };
      next();
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'API key not valid' } }),
    }) as any;

    const response = await request(app).get('/api/v1/debug/ai-studio-models');

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.google_error).toEqual({ error: { message: 'API key not valid' } });
  });
});
