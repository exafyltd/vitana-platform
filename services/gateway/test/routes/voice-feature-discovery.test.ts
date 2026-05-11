/**
 * VTID-02923 (B0e.3) — GET /api/v1/voice/feature-discovery/preview tests.
 *
 * Verifies request validation + response shape. Auth is mocked out for
 * unit testing; the real auth chain is requireAuthWithTenant +
 * requireExafyAdmin (same as B0c Journey Context).
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireAuthWithTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock the supabase getter so the fetcher returns empty arrays.
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => null }));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-feature-discovery').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('B0e.3 — GET /api/v1/voice/feature-discovery/preview', () => {
  it('returns 400 when userId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/feature-discovery/preview?tenantId=t');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userId and tenantId are required/);
  });

  it('returns 400 when tenantId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/feature-discovery/preview?userId=u');
    expect(res.status).toBe(400);
  });

  it('returns 400 on an invalid surface', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/feature-discovery/preview?userId=u&tenantId=t&surface=invented',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/surface must be one of/);
  });

  it('accepts orb_turn_end (default firing surface)', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/feature-discovery/preview?userId=u&tenantId=t&surface=orb_turn_end',
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.catalog).toEqual([]);
    expect(res.body.awareness).toEqual([]);
    expect(res.body.provider.key).toBe('feature_discovery');
  });

  it('orb_wake preview surfaces the defensive-skip reason from the provider', async () => {
    // Even though the inspection route ALLOWS orb_wake (so operators
    // can see the defensive-skip reason), the provider returns
    // status='returned' on wake when includeOrbWake=true. The route
    // creates the provider with includeOrbWake=true so the panel can
    // see what the provider would do if wake were ever enabled.
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/feature-discovery/preview?userId=u&tenantId=t&surface=orb_wake',
    );
    expect(res.status).toBe(200);
    // No catalog (DB stubbed null) → provider suppresses.
    expect(res.body.provider.status).toBe('suppressed');
  });

  it('returns provider status + catalog + awareness in the documented shape', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/feature-discovery/preview?userId=u&tenantId=t&surface=orb_turn_end',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      vtid: 'VTID-02923',
      catalog: expect.any(Array),
      awareness: expect.any(Array),
      provider: {
        key: 'feature_discovery',
        status: expect.any(String),
        latencyMs: expect.any(Number),
      },
    });
  });

  it('passes envelopeJourneySurface to the provider', async () => {
    const app = buildApp();
    const res = await request(app).get(
      '/api/v1/voice/feature-discovery/preview?userId=u&tenantId=t&surface=orb_turn_end&envelopeJourneySurface=intent_board',
    );
    expect(res.status).toBe(200);
    // No catalog (DB stubbed) so still suppresses, but the route did
    // not 400 — the envelope value was passed through.
    expect(res.body.provider.status).toBe('suppressed');
  });
});
