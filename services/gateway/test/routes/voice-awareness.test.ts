/**
 * Tests for src/routes/voice-awareness.ts (VTID-02859)
 *
 *   GET /api/v1/voice/awareness/watchdogs — admin only (VTID-04339).
 *       requireAuth is stubbed (no real JWT verification in a unit test);
 *       requireExafyAdmin is the real middleware.
 */
import request from 'supertest';
import express from 'express';

const mockGetWatchdogStatuses = jest.fn();
jest.mock('../../src/services/awareness-watchdogs', () => ({
  getWatchdogStatuses: (...args: unknown[]) => mockGetWatchdogStatuses(...args),
}));

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  ...jest.requireActual('../../src/middleware/auth-supabase-jwt'),
  requireAuth: (req: any, res: any, next: () => void) => {
    const h = req.headers.authorization;
    if (!h) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    req.identity = { user_id: 'u1', tenant_id: 't1', exafy_admin: h === 'Bearer admin' };
    next();
  },
}));

import router from '../../src/routes/voice-awareness';

const app = express();
app.use(express.json());
app.use('/api/v1', router);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/v1/voice/awareness/watchdogs', () => {
  it('rejects a request without an Authorization header (401) and never reads telemetry', async () => {
    const res = await request(app).get('/api/v1/voice/awareness/watchdogs');

    expect(res.status).toBe(401);
    expect(mockGetWatchdogStatuses).not.toHaveBeenCalled();
  });

  it('rejects an authenticated non-admin (403)', async () => {
    const res = await request(app)
      .get('/api/v1/voice/awareness/watchdogs')
      .set('Authorization', 'Bearer member');

    expect(res.status).toBe(403);
    expect(mockGetWatchdogStatuses).not.toHaveBeenCalled();
  });

  it('returns the watchdog statuses to an exafy admin', async () => {
    const statuses = [
      { name: 'silent-fallback', verdict: 'pass' },
      { name: 'zombie-detector', verdict: 'fail' },
    ];
    mockGetWatchdogStatuses.mockResolvedValue(statuses);

    const res = await request(app)
      .get('/api/v1/voice/awareness/watchdogs')
      .set('Authorization', 'Bearer admin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, watchdogs: statuses, vtid: 'VTID-02859' });
  });

  it('returns 500 with the error message when the service throws', async () => {
    mockGetWatchdogStatuses.mockRejectedValue(new Error('registry unavailable'));

    const res = await request(app)
      .get('/api/v1/voice/awareness/watchdogs')
      .set('Authorization', 'Bearer admin');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'registry unavailable', vtid: 'VTID-02859' });
  });
});
