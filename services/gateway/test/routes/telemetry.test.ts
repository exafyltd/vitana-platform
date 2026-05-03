import express from 'express';
import request from 'supertest';
import { router } from '../../src/routes/telemetry';
import { supabase } from '../../src/lib/supabase';

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock node-fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

const app = express();
app.use(express.json());
app.use('/api/v1/telemetry', router);

describe('Telemetry Routes Auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE = 'test-svc-key';
    process.env.SUPABASE_URL = 'http://test-supabase.local';
  });

  const validPayload = {
    vtid: "VT-123",
    layer: "app",
    module: "test",
    source: "test-src",
    kind: "test.event",
    status: "success",
    title: "Test Event"
  };

  describe('POST /api/v1/telemetry/event', () => {
    it('returns 401 if no token is provided', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validPayload);
        
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it('returns 401 if an invalid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: new Error('Invalid token') 
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer invalid-token')
        .send(validPayload);
        
      expect(res.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith('invalid-token');
    });

    it('proceeds to handler if valid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: 'user-1' } }, 
        error: null 
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const res = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);
        
      expect(res.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith('valid-token');
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/telemetry/batch', () => {
    it('returns 401 if no token is provided', async () => {
      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .send([validPayload]);
        
      expect(res.status).toBe(401);
    });

    it('proceeds to handler if valid token is provided', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: 'user-1' } }, 
        error: null 
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ([{}])
      });

      const res = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer valid-token')
        .send([validPayload]);
        
      expect(res.status).toBe(202);
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});