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

jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn()
}));

global.fetch = jest.fn() as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/telemetry', router);

describe('Telemetry Routes Auth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('POST /api/v1/telemetry/event', () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "test-src",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    };

    it('returns 401 when missing auth token', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('returns 401 when token is invalid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token' }
      });

      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer invalid-token')
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });

    it('proceeds to 202 when token is valid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null
      });

      process.env.SUPABASE_URL = 'http://localhost';
      process.env.SUPABASE_SERVICE_ROLE = 'test-key';
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);
      
      expect(response.status).toBe(202);
    });
  });

  describe('POST /api/v1/telemetry/batch', () => {
    const validPayload = [{
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "test-src",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    }];

    it('returns 401 when missing auth token', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/batch')
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
    });
    
    it('proceeds to 202 when token is valid', async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null
      });

      process.env.SUPABASE_URL = 'http://localhost';
      process.env.SUPABASE_SERVICE_ROLE = 'test-key';
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({})
      });

      const response = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);
      
      expect(response.status).toBe(202);
    });
  });
});