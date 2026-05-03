import express from 'express';
import request from 'supertest';
import { router } from '../../src/routes/telemetry';
import { supabase } from '../../src/lib/supabase';

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub broadcasting to prevent unhandled requirements
jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

describe('Telemetry Routes Auth Enforcement', () => {
  let app: express.Express;
  const originalFetch = global.fetch;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/telemetry', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'http://mock-supabase-url';
    process.env.SUPABASE_SERVICE_ROLE = 'mock-service-role-key';

    // Prevent network calls during tests
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      } as any)
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const validEvent = {
    vtid: "test-vtid",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test.event",
    status: "success",
    title: "Test Event"
  };

  describe('POST /event', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 401 when an invalid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Invalid token' }
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer invalid-token')
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 202 when a valid token is provided and persists the event', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: 'user-123' } },
        error: null
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer valid-token')
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /batch', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .send([validEvent]);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 401 when an invalid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Invalid token' }
      });

      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer invalid-token')
        .send([validEvent]);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 202 when a valid token is provided and persists the batch', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: 'user-123' } },
        error: null
      });

      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer valid-token')
        .send([validEvent]);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(res.body.count).toBe(1);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});