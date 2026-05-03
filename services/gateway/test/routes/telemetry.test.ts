import express from 'express';
import request from 'supertest';
import { router } from '../../src/routes/telemetry';
import { supabase } from '../../src/lib/supabase';

// Mock Supabase
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock devhub to prevent SSE broadcast require errors during testing
jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn()
}), { virtual: true });

const app = express();
app.use(express.json());
app.use('/api/v1/telemetry', router);

describe('Telemetry Routes Auth Enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.SUPABASE_URL = 'http://localhost:8000';
    process.env.SUPABASE_SERVICE_ROLE = 'test-svc-key';
  });

  const validEvent = {
    vtid: 'VT-123',
    layer: 'test',
    module: 'test',
    source: 'test',
    kind: 'test.event',
    status: 'success',
    title: 'Test Event'
  };

  describe('POST /event', () => {
    it('should return 401 when no auth token is provided', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('should return 401 when an invalid auth token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error('Invalid token')
      });

      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer bad-token')
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('should process the event when a valid token is provided', async () => {
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
        .set('Authorization', 'Bearer good-token')
        .send(validEvent);

      expect(response.status).toBe(202);
    });
  });

  describe('POST /batch', () => {
    it('should return 401 when no auth token is provided', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/batch')
        .send([validEvent]);

      expect(response.status).toBe(401);
    });

    it('should return 202 when a valid token is provided', async () => {
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
        .set('Authorization', 'Bearer good-token')
        .send([validEvent]);

      expect(response.status).toBe(202);
    });
  });

  describe('GET /health', () => {
    it('should remain accessible without authentication', async () => {
      const response = await request(app).get('/api/v1/telemetry/health');
      expect(response.status).toBe(200);
    });
  });
  
  describe('GET /snapshot', () => {
    it('should remain accessible without authentication', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ([]) })
        .mockResolvedValueOnce({ ok: true, json: async () => ([]) });

      const response = await request(app).get('/api/v1/telemetry/snapshot');
      expect(response.status).toBe(200);
    });
  });
});