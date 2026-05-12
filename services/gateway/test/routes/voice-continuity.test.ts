/**
 * VTID-02932 (B2) — GET /api/v1/voice/continuity/preview tests.
 *
 * Verifies:
 *   - Validates userId + tenantId (400 when missing).
 *   - Calls the default fetcher with the provided ids.
 *   - Returns ok:true with threads + promises + compiled context.
 *   - Returns 500 with vtid when the fetcher throws unexpectedly.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const listOpenThreads = jest.fn();
const listPromises = jest.fn();

jest.mock('../../src/services/continuity/continuity-fetcher', () => ({
  defaultContinuityFetcher: {
    listOpenThreads: (args: any) => listOpenThreads(args),
    listPromises: (args: any) => listPromises(args),
  },
}));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-continuity').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('B2 — GET /api/v1/voice/continuity/preview', () => {
  beforeEach(() => {
    listOpenThreads.mockReset();
    listPromises.mockReset();
  });

  it('returns 400 when userId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/continuity/preview?tenantId=t');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.vtid).toBe('VTID-02932');
  });

  it('returns 400 when tenantId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/continuity/preview?userId=u');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns ok:true with rows + compiled context', async () => {
    listOpenThreads.mockResolvedValueOnce({ ok: true, rows: [] });
    listPromises.mockResolvedValueOnce({ ok: true, rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/continuity/preview?userId=u&tenantId=t');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vtid).toBe('VTID-02932');
    expect(Array.isArray(res.body.threads)).toBe(true);
    expect(Array.isArray(res.body.promises)).toBe(true);
    expect(res.body.context).toBeDefined();
    expect(res.body.context.open_threads).toEqual([]);
    expect(res.body.context.promises_owed).toEqual([]);
    expect(res.body.context.source_health.user_open_threads.ok).toBe(true);
    expect(res.body.context.source_health.assistant_promises.ok).toBe(true);
  });

  it('passes userId + tenantId through to the fetcher', async () => {
    listOpenThreads.mockResolvedValueOnce({ ok: true, rows: [] });
    listPromises.mockResolvedValueOnce({ ok: true, rows: [] });

    const app = buildApp();
    await request(app).get('/api/v1/voice/continuity/preview?userId=alice&tenantId=acme');
    expect(listOpenThreads).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'alice', tenantId: 'acme', limit: 50 }),
    );
    expect(listPromises).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'alice', tenantId: 'acme', limit: 50 }),
    );
  });

  it('reflects fetcher source-health failures in the compiled context', async () => {
    listOpenThreads.mockResolvedValueOnce({ ok: false, rows: [], reason: 'supabase_unconfigured' });
    listPromises.mockResolvedValueOnce({ ok: true, rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/continuity/preview?userId=u&tenantId=t');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.context.source_health.user_open_threads.ok).toBe(false);
    expect(res.body.context.source_health.user_open_threads.reason).toBe('supabase_unconfigured');
  });

  it('returns 500 with vtid when the fetcher throws unexpectedly', async () => {
    listOpenThreads.mockRejectedValueOnce(new Error('boom'));
    listPromises.mockResolvedValueOnce({ ok: true, rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/continuity/preview?userId=u&tenantId=t');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.vtid).toBe('VTID-02932');
  });
});
