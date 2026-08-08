/**
 * Tests for src/routes/voice-awareness.ts (VTID-02859)
 *
 *   GET /api/v1/voice/awareness/watchdogs — NO auth middleware at all
 *       (route file has no auth imports; mounted with mountRouterSync,
 *       which is only a duplicate-route guard, not an auth gate).
 */
import request from 'supertest';
import express from 'express';

const mockGetWatchdogStatuses = jest.fn();
jest.mock('../../src/services/awareness-watchdogs', () => ({
  getWatchdogStatuses: (...args: unknown[]) => mockGetWatchdogStatuses(...args),
}));

import router from '../../src/routes/voice-awareness';

const app = express();
app.use(express.json());
app.use('/api/v1', router);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/v1/voice/awareness/watchdogs', () => {
  it('is reachable without any Authorization header and returns the watchdog statuses', async () => {
    const statuses = [
      { name: 'silent-fallback', verdict: 'pass' },
      { name: 'zombie-detector', verdict: 'fail' },
    ];
    mockGetWatchdogStatuses.mockResolvedValue(statuses);

    const res = await request(app).get('/api/v1/voice/awareness/watchdogs');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, watchdogs: statuses, vtid: 'VTID-02859' });
  });

  it('returns 500 with the error message when the service throws', async () => {
    mockGetWatchdogStatuses.mockRejectedValue(new Error('registry unavailable'));

    const res = await request(app).get('/api/v1/voice/awareness/watchdogs');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'registry unavailable', vtid: 'VTID-02859' });
  });
});
