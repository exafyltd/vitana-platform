import request from 'supertest';
import express from 'express';
import { router } from '../../src/routes/telemetry';
import { supabase } from '../../src/lib/supabase';

// Mock the supabase client
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub inline require to prevent errors during tests
jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use('/api/v1/telemetry', router);

describe('Telemetry Routes Authorization', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
    process.env.SUPABASE_URL = 'http://localhost:8000';
    process.env.SUPABASE_SERVICE_ROLE = 'test-svc-key';
  });

  afterAll(() => {
    global.fetch = originalFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock global fetch to return success for Supabase REST calls
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => 'OK',
    } as any);
  });

  const validEventPayload = {
    vtid: 'VTID-123',
    layer: 'test-layer',
    module: 'test-module',
    source: 'test-source',
    kind: 'test.kind',
    status: 'success',
    title: 'Test Title'
  };

  describe('POST /api/v1/telemetry/event', () => {
    it('should return 401 Unauthorized if no token is provided', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return 401 Unauthorized if token is invalid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error('Invalid token'),
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer invalid-token')
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith('invalid-token');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return 202 Accepted if token is valid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: 'user-123' } },
        error: null,
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer valid-token')
        .send(validEventPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith('valid-token');
      expect(global.fetch).toHaveBeenCalled(); // Should proceed to save to OASIS
    });
  });

  describe('POST /api/v1/telemetry/batch', () => {
    const batchPayload = [validEventPayload, validEventPayload];

    it('should return 401 Unauthorized if no token is provided', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .send(batchPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return 401 Unauthorized if token is invalid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error('Invalid token'),
      });

      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer invalid-token')
        .send(batchPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return 202 Accepted if token is valid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: 'user-123' } },
        error: null,
      });

      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer valid-token')
        .send(batchPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});