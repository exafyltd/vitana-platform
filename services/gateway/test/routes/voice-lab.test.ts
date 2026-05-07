import request from 'supertest';
import express from 'express';

// Mock the authentication middleware
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    // Allow public route to pass through (simulating scanner/bypass rules)
    if (req.path === '/health') {
      return next();
    }
    // Reject all other endpoints
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }),
}));

import voiceLabRouter from '../../src/routes/voice-lab';

describe('Voice Lab API Auth Rules', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Mount the router
    app.use('/api/v1/voice-lab', voiceLabRouter);
  });

  it('should allow unauthenticated requests to public-route /health', async () => {
    const res = await request(app).get('/api/v1/voice-lab/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: 'voice-lab',
      vtid: 'VTID-01218A',
      timestamp: expect.any(String),
    });
  });

  it('should reject unauthenticated requests to protected routes', async () => {
    let res = await request(app).get('/api/v1/voice-lab/live/sessions');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Unauthorized' });

    res = await request(app).post('/api/v1/voice-lab/probe');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Unauthorized' });

    res = await request(app).post('/api/v1/voice-lab/healing/investigate');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Unauthorized' });

    res = await request(app).get('/api/v1/voice-lab/debug/events');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Unauthorized' });
  });
});