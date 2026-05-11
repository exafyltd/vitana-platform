/**
 * VTID-02936 (B3) — GET /api/v1/voice/concept-mastery/preview tests.
 *
 * Verifies:
 *   - Validates userId + tenantId (400 when missing).
 *   - Calls the default fetcher with the provided ids.
 *   - Returns ok:true with raw arrays + compiled context.
 *   - Returns 500 with vtid when the fetcher throws unexpectedly.
 *   - Reflects fetcher source-health failures in the compiled context.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (_req: any, _res: any, next: any) => next(),
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const listConceptState = jest.fn();

jest.mock('../../src/services/concept-mastery/concept-mastery-fetcher', () => ({
  defaultConceptMasteryFetcher: {
    listConceptState: (args: any) => listConceptState(args),
  },
}));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-concept-mastery').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('B3 — GET /api/v1/voice/concept-mastery/preview', () => {
  beforeEach(() => {
    listConceptState.mockReset();
  });

  it('returns 400 when userId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/concept-mastery/preview?tenantId=t');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.vtid).toBe('VTID-02936');
  });

  it('returns 400 when tenantId is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/concept-mastery/preview?userId=u');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns ok:true with raw arrays + compiled context', async () => {
    listConceptState.mockResolvedValueOnce({
      ok: true,
      concepts_explained: [],
      concepts_mastered: [],
      dyk_cards_seen: [],
    });

    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/concept-mastery/preview?userId=u&tenantId=t');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vtid).toBe('VTID-02936');
    expect(Array.isArray(res.body.concepts_explained)).toBe(true);
    expect(Array.isArray(res.body.concepts_mastered)).toBe(true);
    expect(Array.isArray(res.body.dyk_cards_seen)).toBe(true);
    expect(res.body.context).toBeDefined();
    expect(res.body.context.concepts_explained).toEqual([]);
    expect(res.body.context.source_health.user_assistant_state.ok).toBe(true);
  });

  it('passes userId + tenantId through to the fetcher', async () => {
    listConceptState.mockResolvedValueOnce({
      ok: true, concepts_explained: [], concepts_mastered: [], dyk_cards_seen: [],
    });
    const app = buildApp();
    await request(app).get('/api/v1/voice/concept-mastery/preview?userId=alice&tenantId=acme');
    expect(listConceptState).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'alice', tenantId: 'acme', limit: 500 }),
    );
  });

  it('reflects fetcher source-health failures in the compiled context', async () => {
    listConceptState.mockResolvedValueOnce({
      ok: false,
      concepts_explained: [],
      concepts_mastered: [],
      dyk_cards_seen: [],
      reason: 'supabase_unconfigured',
    });
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/concept-mastery/preview?userId=u&tenantId=t');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.context.source_health.user_assistant_state.ok).toBe(false);
    expect(res.body.context.source_health.user_assistant_state.reason).toBe('supabase_unconfigured');
  });

  it('returns 500 with vtid when the fetcher throws unexpectedly', async () => {
    listConceptState.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp();
    const res = await request(app).get('/api/v1/voice/concept-mastery/preview?userId=u&tenantId=t');
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.vtid).toBe('VTID-02936');
  });
});
