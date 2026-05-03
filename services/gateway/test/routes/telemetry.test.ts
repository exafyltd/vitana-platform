import request from 'supertest';
import express from 'express';
import { router } from '../../src/routes/telemetry';
import { supabase } from '../../src/lib/supabase';

// Mock Supabase client
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock devhub broadcast to avoid errors when dynamic require is called
jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn()
}), { virtual: true });

describe('Telemetry Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/telemetry', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'http://localhost:8000';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-key';
  });

  describe('Auth Middleware Enforcement', () => {
    const validEvent = {
      vtid: 'VTID-123',
      layer: 'test-layer',
      module: 'test-module',
      source: 'test-source',
      kind: 'test.event',
      status: 'success',
      title: 'Test Event'
    };

    describe('POST /api/v1/telemetry/event', () => {
      it('should return 401 if Authorization header is missing', async () => {
        const response = await request(app)
          .post('/api/v1/telemetry/event')
          .send(validEvent);
        
        expect(response.status).toBe(401);
        expect(response.body.error).toBe('Unauthorized');
      });

      it('should return 401 if token is invalid', async () => {
        (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
          data: { user: null },
          error: new Error('Invalid token')
        });

        const response = await request(app)
          .post('/api/v1/telemetry/event')
          .set('Authorization', 'Bearer invalid-token')
          .send(validEvent);
        
        expect(response.status).toBe(401);
        expect(response.body.error).toBe('Unauthorized');
        expect(supabase.auth.getUser).toHaveBeenCalledWith('invalid-token');
      });

      it('should proceed if token is valid', async () => {
        (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
          data: { user: { id: 'user-123' } },
          error: null
        });

        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({})
        }) as any;

        const response = await request(app)
          .post('/api/v1/telemetry/event')
          .set('Authorization', 'Bearer valid-token')
          .send(validEvent);
        
        expect(response.status).toBe(202);
        expect(global.fetch).toHaveBeenCalled();

        global.fetch = originalFetch;
      });
    });

    describe('POST /api/v1/telemetry/batch', () => {
      const validBatch = [validEvent];

      it('should return 401 if Authorization header is missing', async () => {
        const response = await request(app)
          .post('/api/v1/telemetry/batch')
          .send(validBatch);
        
        expect(response.status).toBe(401);
      });

      it('should return 401 if token is invalid', async () => {
        (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
          data: { user: null },
          error: new Error('Invalid token')
        });

        const response = await request(app)
          .post('/api/v1/telemetry/batch')
          .set('Authorization', 'Bearer invalid-token')
          .send(validBatch);
        
        expect(response.status).toBe(401);
      });

      it('should proceed if token is valid', async () => {
        (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
          data: { user: { id: 'user-123' } },
          error: null
        });

        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({})
        }) as any;

        const response = await request(app)
          .post('/api/v1/telemetry/batch')
          .set('Authorization', 'Bearer valid-token')
          .send(validBatch);
        
        expect(response.status).toBe(202);

        global.fetch = originalFetch;
      });
    });

    describe('GET /api/v1/telemetry/health', () => {
      it('should return 200 without auth as it is a read-only unauthenticated route', async () => {
        const response = await request(app).get('/api/v1/telemetry/health');
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });
    });
  });
});