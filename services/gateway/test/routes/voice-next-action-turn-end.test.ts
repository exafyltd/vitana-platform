/**
 * VTID-03064 (B0d-real Xg) — POST /voice/next-action/turn-end tests.
 *
 * Covers the happy + error paths of the turn-end endpoint. Uses the
 * real composer wired with stub sources so the composer/decideContinuation
 * loop is exercised end-to-end.
 */

import express from 'express';
import request from 'supertest';

// Mock the OASIS emit so we observe topics without persisting events.
const emitMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => emitMock(...args),
}));

// Inject a fixed JWT identity.
const FIXED_IDENTITY = {
  user_id: 'jwt-user-id',
  tenant_id: 'jwt-tenant-id',
};
let currentIdentity: typeof FIXED_IDENTITY | null = FIXED_IDENTITY;
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, _res: any, next: any) => {
    if (currentIdentity) req.identity = currentIdentity;
    next();
  },
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

// Supabase fake — every source query returns no rows. The composer
// then has nothing to fire and we expect a suppressed result. That's
// fine for the route-level test; per-source happy paths are covered
// in the dedicated source test files.
function fakeSupabase(): any {
  const chain: any = {};
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.neq = () => chain;
  chain.gte = () => chain;
  chain.lte = () => chain;
  chain.order = () => chain;
  chain.limit = () => Promise.resolve({ data: [], error: null });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return {
    from: () => ({ select: () => chain }),
    rpc: async () => ({ data: null, error: null }),
  };
}
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => fakeSupabase(),
}));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-next-action-turn-end').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('VTID-03064 — POST /api/v1/voice/next-action/turn-end', () => {
  beforeEach(() => {
    emitMock.mockClear();
    currentIdentity = FIXED_IDENTITY;
  });

  it('returns 200 + continuation:null when no source qualifies (all empty)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/next-action/turn-end')
      .send({ lang: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.surface).toBe('orb_turn_end');
    expect(res.body.continuation).toBeNull();
    expect(res.body.decision.selected_kind).toBe('none_with_reason');
    // Composer suppressed because all sources returned empty.
    expect(res.body.decision.suppress_reason).toBeTruthy();
  });

  it('returns 401 when identity is missing', async () => {
    currentIdentity = null;
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/next-action/turn-end')
      .send({ lang: 'en' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('accepts no body and defaults lang to en', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/next-action/turn-end')
      .send({});
    expect(res.status).toBe(200);
  });

  it('emits OASIS suppressed when the composer suppresses', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/v1/voice/next-action/turn-end')
      .send({ lang: 'en' });
    // Best-effort + microtask-flushed.
    return Promise.resolve().then(() => {
      const topics = emitMock.mock.calls.map((c) => (c[0] as { type?: string })?.type);
      // At least one of next_action.* fires; suppressed when no source.
      expect(
        topics.some((t) => typeof t === 'string' && t.startsWith('orb.livekit.next_action.')),
      ).toBe(true);
    });
  });
});
