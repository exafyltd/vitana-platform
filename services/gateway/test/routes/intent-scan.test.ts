/**
 * routes/intent-scan.ts — first test coverage (previously zero).
 *
 * Focused on the three previously-unchecked Supabase reads: a real DB
 * error on any of them silently resolved to an empty result set,
 * indistinguishable from "genuinely nothing matches" — this pins that
 * each is now at least logged loudly rather than silently swallowed.
 * The route intentionally keeps degrading to empty results (a discovery/
 * matching read, not a critical path), so the fix here is visibility,
 * not a behavior change.
 */
import express, { NextFunction, Response } from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.identity = { user_id: 'user-1', tenant_id: 'tenant-1' };
    next();
  },
  requireTenant: (_req: any, _res: Response, next: NextFunction) => next(),
}));

const mockFetchCompatibleIntentKinds = jest.fn();
const mockFetchOpenCompatibleIntents = jest.fn();
const mockFetchDancePrefProfiles = jest.fn();
jest.mock('../../src/routes/intent-scan-repository', () => ({
  fetchCompatibleIntentKinds: (...args: unknown[]) => mockFetchCompatibleIntentKinds(...args),
  fetchOpenCompatibleIntents: (...args: unknown[]) => mockFetchOpenCompatibleIntents(...args),
  fetchDancePrefProfiles: (...args: unknown[]) => mockFetchDancePrefProfiles(...args),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => ({})),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentScanRouter = require('../../src/routes/intent-scan').default;

function makeApp() {
  const app = express();
  app.use('/api/v1', intentScanRouter);
  return app;
}

describe('GET /api/v1/intent-scan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchCompatibleIntentKinds.mockResolvedValue({ data: [], error: null });
    mockFetchOpenCompatibleIntents.mockResolvedValue({ data: [], error: null });
    mockFetchDancePrefProfiles.mockResolvedValue({ data: [], error: null });
  });

  it('200 with empty lists, unchanged happy path', async () => {
    const res = await request(makeApp()).get('/api/v1/intent-scan').query({ intent_kind: 'dance_partner' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, open_intents: [] });
  });

  it('logs loudly (not silently) when any of the three reads errors, still returns 200 with empty results', async () => {
    mockFetchCompatibleIntentKinds.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    mockFetchOpenCompatibleIntents.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    mockFetchDancePrefProfiles.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(makeApp())
      .get('/api/v1/intent-scan')
      .query({ intent_kind: 'dance_partner', category_prefix: 'dance.salsa' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, open_intents: [] });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchCompatibleIntentKinds failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchOpenCompatibleIntents failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchDancePrefProfiles failed'));
    errorSpy.mockRestore();
  });
});
