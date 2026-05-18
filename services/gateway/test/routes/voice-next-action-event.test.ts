/**
 * VTID-03062 (B0d-real Xf.2) — POST /api/v1/voice/next-action/event tests.
 *
 * Pure route-level tests. The OASIS emitter is mocked so we verify:
 *   - HTTP contract (200 / 400 / 401 / 502)
 *   - Tenant + user come from JWT, never body
 *   - Topic selection: accepted → orb.livekit.next_action.accepted,
 *     dismissed → orb.livekit.next_action.dismissed
 *   - Field-length + key-count limits
 *   - Surface enum gate
 */

import express from 'express';
import request from 'supertest';

// Mock OASIS emit so we observe topics without persisting events.
const emitMock = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => emitMock(...args),
}));

// Inject a per-test mutable identity. Tests flip `currentIdentity` to
// null to simulate an unauthenticated request and the auth mock then
// leaves req.identity undefined — the route returns 401.
const FIXED_IDENTITY = {
  user_id: 'jwt-user-id',
  tenant_id: 'jwt-tenant-id',
};
let currentIdentity: typeof FIXED_IDENTITY | null = FIXED_IDENTITY;
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, _res: any, next: any) => {
    if (currentIdentity) req.identity = currentIdentity;
    // else leave req.identity undefined → route's own guard returns 401.
    next();
  },
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-next-action-event').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('VTID-03062 — POST /api/v1/voice/next-action/event', () => {
  beforeEach(() => {
    emitMock.mockReset();
    emitMock.mockResolvedValue({ ok: true });
    currentIdentity = FIXED_IDENTITY;
  });

  it('returns 200 + emits orb.livekit.next_action.accepted on eventName=accepted', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/next-action/event')
      .send({
        decisionId: 'd-123',
        dedupeKey: 'reminder_due:r-9',
        eventName: 'accepted',
        source: 'reminder_due',
        surface: 'orb_wake',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.topic).toBe('orb.livekit.next_action.accepted');
    expect(emitMock).toHaveBeenCalledTimes(1);
    const call = emitMock.mock.calls[0][0];
    expect(call.type).toBe('orb.livekit.next_action.accepted');
    expect(call.payload.decision_id).toBe('d-123');
    expect(call.payload.dedupe_key).toBe('reminder_due:r-9');
    expect(call.payload.user_id).toBe('jwt-user-id');
    expect(call.payload.tenant_id).toBe('jwt-tenant-id');
    expect(call.payload.source).toBe('reminder_due');
    expect(call.payload.surface).toBe('orb_wake');
  });

  it('returns 200 + emits dismissed on eventName=dismissed', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      decisionId: 'd-456',
      dedupeKey: 'autopilot_recommendation:rec-1',
      eventName: 'dismissed',
    });
    expect(res.status).toBe(200);
    expect(res.body.topic).toBe('orb.livekit.next_action.dismissed');
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0][0].type).toBe('orb.livekit.next_action.dismissed');
  });

  it('returns 400 on missing decisionId', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      dedupeKey: 'x:1',
      eventName: 'accepted',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/decisionId/);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('returns 400 on missing dedupeKey', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      decisionId: 'd-1',
      eventName: 'accepted',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dedupeKey/);
  });

  it('returns 400 on bad eventName', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      decisionId: 'd-1',
      dedupeKey: 'x:1',
      eventName: 'completed', // not accepted/dismissed
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eventName must be one of/);
  });

  it('returns 401 when identity is missing', async () => {
    // Flip the mutable identity to null so the auth mock leaves
    // req.identity undefined — the route's own guard returns 401.
    currentIdentity = null;
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      decisionId: 'd-1',
      dedupeKey: 'x:1',
      eventName: 'accepted',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 502 when emit throws', async () => {
    emitMock.mockRejectedValueOnce(new Error('OASIS down'));
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      decisionId: 'd-1',
      dedupeKey: 'x:1',
      eventName: 'accepted',
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('telemetry_emit_failed');
  });

  it('drops invalid surface enum to null (does not 400)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      decisionId: 'd-1',
      dedupeKey: 'x:1',
      eventName: 'accepted',
      surface: 'invalid_surface',
    });
    expect(res.status).toBe(200);
    const payload = emitMock.mock.calls[0][0].payload;
    expect(payload.surface).toBeNull();
  });

  it('rejects metadata with >16 keys', async () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 17; i++) big[`k${i}`] = i;
    const app = buildApp();
    const res = await request(app).post('/api/v1/voice/next-action/event').send({
      decisionId: 'd-1',
      dedupeKey: 'x:1',
      eventName: 'accepted',
      metadata: big,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metadata has more than/);
  });
});
