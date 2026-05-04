import request from 'supertest';
import express from 'express';
import { router } from '../../src/routes/telemetry';
import { supabase } from '../../src/lib/supabase';

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn(),
}));

describe('Telemetry Routes Auth Enforcement', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.SUPABASE_SERVICE_ROLE = 'test-svc-key';
    process.env.SUPABASE_URL = 'http://localhost:8000';
    app = express();
    app.use(express.json());
    app.use('/api/v1/telemetry', router);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const validEvent = {
    vtid: 'VTID-123',
    layer: 'test-layer',
    module: 'test-module',
    source: 'test-source',
    kind: 'test.kind',
    status: 'success',
    title: 'Test Event'
  };

  describe('POST /api/v1/telemetry/event', () => {
    it('returns 401 when no token is provided', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('returns 401 when an invalid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Invalid token' }
      });

      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer invalid-token')
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
      expect(supabase.auth.getUser).toHaveBeenCalledWith('invalid-token');
    });

    it('returns 202 when a valid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: 'user-123' } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer valid-token')
        .send(validEvent);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith('valid-token');
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/telemetry/batch', () => {
    const validEvents = [validEvent];

    it('returns 401 when no token is provided', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/batch')
        .send(validEvents);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('returns 202 when a valid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: 'user-123' } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer valid-token')
        .send(validEvents);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
    });
  });

  describe('GET /api/v1/telemetry/health', () => {
    it('returns 200 and does not require auth', async () => {
      const response = await request(app).get('/api/v1/telemetry/health');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });
});