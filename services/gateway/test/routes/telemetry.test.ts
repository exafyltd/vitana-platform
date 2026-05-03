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

// Mock dynamic require inside telemetry routes
jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use('/api/v1/telemetry', router);

describe('Telemetry Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE = 'mock-svc-key';
    process.env.SUPABASE_URL = 'http://mock-supabase.local';
    
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => 'OK'
    });
  });

  describe('POST /api/v1/telemetry/event', () => {
    const validPayload = {
      vtid: 'VTID-1234',
      layer: 'app',
      module: 'auth',
      source: 'web',
      kind: 'auth.login',
      status: 'success',
      title: 'User logged in'
    };

    it('returns 401 if missing Authorization header', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 401 if token is invalid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error('Invalid token')
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer invalid-token')
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('proceeds and returns 202 if token is valid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/v1/telemetry/batch', () => {
    const validPayload = [{
      vtid: 'VTID-1234',
      layer: 'app',
      module: 'auth',
      source: 'web',
      kind: 'auth.login',
      status: 'success',
      title: 'User logged in'
    }];

    it('returns 401 if missing Authorization header', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 202 if token is valid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null
      });

      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});