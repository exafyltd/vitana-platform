/**
 * VTID-03827: Cognito branch of routes/auth.ts's /login, /refresh, and
 * /health.
 *
 * Scope: only the NEW provider-branching logic. The pre-existing Supabase
 * GoTrue path's side effects (profile enrichment, welcome notifications,
 * group enrollment) are exercised elsewhere/manually and are deliberately
 * short-circuited here via a null getSupabase() — this file is not trying
 * to re-test that pre-existing behavior, only that it's untouched when
 * Cognito isn't configured, and that the new Cognito branch is wired
 * correctly and never touches Supabase GoTrue when it IS configured.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../../src/services/cognito-auth-client', () => ({
  isCognitoAuthConfigured: jest.fn(),
  cognitoLogin: jest.fn(),
  cognitoRefresh: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => null,
}));

import {
  isCognitoAuthConfigured,
  cognitoLogin,
  cognitoRefresh,
} from '../../src/services/cognito-auth-client';
import authRouter from '../../src/routes/auth';

const mockIsCognitoAuthConfigured = isCognitoAuthConfigured as jest.Mock;
const mockCognitoLogin = cognitoLogin as jest.Mock;
const mockCognitoRefresh = cognitoRefresh as jest.Mock;

const app = express();
app.use(express.json());
app.use('/auth', authRouter);

describe('routes/auth.ts — Cognito branch (VTID-03827)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('POST /auth/login', () => {
    it('proxies to Cognito and never touches fetch/Supabase when configured', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(true);
      mockCognitoLogin.mockResolvedValue({
        ok: true,
        access_token: 'cognito-id-token',
        refresh_token: 'cognito-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        user: { id: 'legacy-uuid-123', email: 'user@example.com' },
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.com', password: 'hunter2' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        access_token: 'cognito-id-token',
        refresh_token: 'cognito-refresh-token',
        user: { id: 'legacy-uuid-123', email: 'user@example.com' },
      });
      expect(mockCognitoLogin).toHaveBeenCalledWith('user@example.com', 'hunter2');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('maps a Cognito auth failure to the same error envelope shape as the Supabase path', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(true);
      mockCognitoLogin.mockResolvedValue({
        ok: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.com', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        ok: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    });

    it('falls back to Supabase GoTrue when Cognito is not configured', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(false);
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_ANON_KEY = 'anon-key';
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'supabase-token',
          refresh_token: 'supabase-refresh',
          expires_in: 3600,
          token_type: 'bearer',
          user: { id: 'supabase-uuid', email: 'user@example.com' },
        }),
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.com', password: 'hunter2' });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBe('supabase-token');
      expect(mockCognitoLogin).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.supabase.co/auth/v1/token?grant_type=password',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('still validates input before consulting either provider', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(true);
      const res = await request(app).post('/auth/login').send({ email: '', password: 'x' });
      expect(res.status).toBe(400);
      expect(mockCognitoLogin).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/refresh', () => {
    it('proxies to Cognito when configured', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(true);
      mockCognitoRefresh.mockResolvedValue({
        ok: true,
        access_token: 'new-id-token',
        refresh_token: 'same-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });

      const res = await request(app).post('/auth/refresh').send({ refresh_token: 'rt-1' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        access_token: 'new-id-token',
        refresh_token: 'same-refresh-token',
      });
      expect(mockCognitoRefresh).toHaveBeenCalledWith('rt-1');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('maps a Cognito refresh failure to 401 INVALID_REFRESH_TOKEN', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(true);
      mockCognitoRefresh.mockResolvedValue({
        ok: false,
        error: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid email or password',
      });

      const res = await request(app).post('/auth/refresh').send({ refresh_token: 'stale' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('INVALID_REFRESH_TOKEN');
    });

    it('falls back to Supabase GoTrue when Cognito is not configured', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(false);
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_ANON_KEY = 'anon-key';
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-supabase-token',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'bearer',
        }),
      });

      const res = await request(app).post('/auth/refresh').send({ refresh_token: 'rt-old' });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBe('refreshed-supabase-token');
      expect(mockCognitoRefresh).not.toHaveBeenCalled();
    });
  });

  describe('GET /auth/health', () => {
    it('reports active_login_provider=cognito when configured', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(true);
      const res = await request(app).get('/auth/health');
      expect(res.status).toBe(200);
      expect(res.body.config).toMatchObject({
        cognito_configured: true,
        active_login_provider: 'cognito',
      });
    });

    it('reports active_login_provider=supabase when Cognito is not configured', async () => {
      mockIsCognitoAuthConfigured.mockReturnValue(false);
      const res = await request(app).get('/auth/health');
      expect(res.status).toBe(200);
      expect(res.body.config).toMatchObject({
        cognito_configured: false,
        active_login_provider: 'supabase',
      });
    });
  });
});
