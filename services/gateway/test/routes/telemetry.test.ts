import request from 'supertest';
import express from 'express';
import { router } from '../../src/routes/telemetry';

// Mock auth middleware to simulate authenticated and unauthenticated states
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer valid-token')) {
      req.identity = { user_id: 'test-user', email: 'test@example.com' };
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  })
}));

// Mock devhub SSE broadcast to prevent runtime require errors during tests
jest.mock('../../src/routes/devhub', () => ({
  broadcastEvent: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/api/v1/telemetry', router);

describe('Telemetry Routes Auth Enforcement', () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeAll(() => {
    global.fetch = mockFetch as any;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'http://localhost:8000';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-key';
  });

  describe('POST /api/v1/telemetry/event', () => {
    const validEvent = {
      vtid: 'VTID-12345',
      layer: 'test-layer',
      module: 'test-module',
      source: 'test-source',
      kind: 'test.event',
      status: 'success',
      title: 'Test Event'
    };

    it('should return 401 when no authorization header is provided', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .send(validEvent);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should proceed and return 202 when a valid authorization token is provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post('/api/v1/telemetry/event')
        .set('Authorization', 'Bearer valid-token')
        .send(validEvent);
      
      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/v1/telemetry/batch', () => {
    const validBatch = [{
      vtid: 'VTID-12345',
      layer: 'test-layer',
      module: 'test-module',
      source: 'test-source',
      kind: 'test.event',
      status: 'success',
      title: 'Test Event'
    }];

    it('should return 401 when no authorization header is provided', async () => {
      const response = await request(app)
        .post('/api/v1/telemetry/batch')
        .send(validBatch);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should proceed and return 202 when a valid authorization token is provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post('/api/v1/telemetry/batch')
        .set('Authorization', 'Bearer valid-token')
        .send(validBatch);
      
      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/v1/telemetry/snapshot', () => {
    it('should return 401 when no authorization header is provided', async () => {
      const response = await request(app)
        .get('/api/v1/telemetry/snapshot')
        .query({ limit: 5 });
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Unauthorized');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should proceed and return 200 when a valid authorization token is provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ([]) // Events
      }).mockResolvedValueOnce({
        ok: true,
        json: async () => ([]) // Counters
      });

      const response = await request(app)
        .get('/api/v1/telemetry/snapshot')
        .set('Authorization', 'Bearer valid-token')
        .query({ limit: 5 });
      
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});