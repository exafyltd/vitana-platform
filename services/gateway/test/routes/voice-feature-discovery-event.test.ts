/**
 * VTID-02924 (B0e.4) — POST /api/v1/voice/feature-discovery/event tests.
 *
 * Pure route-level tests. The underlying service is mocked so we
 * verify the HTTP contract + tenant/user-from-JWT (NEVER body) +
 * status-code mapping.
 */

import express from 'express';
import request from 'supertest';

// Mock the service the route depends on.
jest.mock(
  '../../src/services/capability-awareness/capability-awareness-service',
  () => {
    const mockIngest = jest.fn();
    return {
      defaultCapabilityAwarenessService: { ingest: mockIngest },
      __mockIngest: mockIngest,
    };
  },
);

// Mock auth — inject a fixed identity so the route can read tenant + user from JWT.
const FIXED_IDENTITY = {
  user_id: 'jwt-user-id',
  tenant_id: 'jwt-tenant-id',
};
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, _res: any, next: any) => {
    req.identity = FIXED_IDENTITY;
    next();
  },
  requireExafyAdmin: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

function getMockIngest(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/services/capability-awareness/capability-awareness-service').__mockIngest;
}

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-feature-discovery-event').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('B0e.4 — POST /api/v1/voice/feature-discovery/event', () => {
  beforeEach(() => {
    getMockIngest().mockReset();
  });

  it('returns 200 with previousState + nextState on a fresh advance', async () => {
    getMockIngest().mockResolvedValueOnce({
      ok: true,
      idempotent: false,
      previousState: 'unknown',
      nextState: 'introduced',
      eventId: 'evt-1',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k1',
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      vtid: 'VTID-02924',
      idempotent: false,
      previousState: 'unknown',
      nextState: 'introduced',
      eventId: 'evt-1',
    });
  });

  it('uses tenantId + userId FROM JWT, never from the body (acceptance #4)', async () => {
    const ingest = getMockIngest();
    ingest.mockResolvedValueOnce({
      ok: true,
      idempotent: false,
      previousState: 'unknown',
      nextState: 'introduced',
      eventId: 'evt-1',
    });
    const app = buildApp();
    await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({
        // Caller tries to inject a different tenant/user via body.
        tenantId: 'hacker-tenant',
        userId: 'hacker-user',
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k1',
      });
    // Service was called with JWT identity, not body identity.
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'jwt-tenant-id',
        userId: 'jwt-user-id',
      }),
    );
    const call = ingest.mock.calls[0][0];
    expect(call.tenantId).not.toBe('hacker-tenant');
    expect(call.userId).not.toBe('hacker-user');
  });

  it('returns 400 when capabilityKey is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({ eventName: 'introduced', idempotencyKey: 'k1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capabilityKey is required/);
  });

  it('returns 400 on invalid eventName', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({ capabilityKey: 'x', eventName: 'made_up', idempotencyKey: 'k' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eventName must be one of/);
  });

  it('returns 400 when idempotencyKey is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({ capabilityKey: 'x', eventName: 'introduced' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotencyKey is required/);
  });

  it('returns 409 on transition_not_allowed', async () => {
    getMockIngest().mockResolvedValueOnce({
      ok: false,
      reason: 'transition_not_allowed',
      previousState: 'mastered',
      detail: 'event=introduced not allowed from state=mastered',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({ capabilityKey: 'x', eventName: 'introduced', idempotencyKey: 'k' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('transition_not_allowed');
    expect(res.body.previousState).toBe('mastered');
  });

  it('returns 404 on unknown_capability', async () => {
    getMockIngest().mockResolvedValueOnce({
      ok: false,
      reason: 'unknown_capability',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({ capabilityKey: 'missing', eventName: 'introduced', idempotencyKey: 'k' });
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('unknown_capability');
  });

  it('returns 503 on database_unavailable', async () => {
    getMockIngest().mockResolvedValueOnce({ ok: false, reason: 'database_unavailable' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({ capabilityKey: 'x', eventName: 'introduced', idempotencyKey: 'k' });
    expect(res.status).toBe(503);
  });

  it('forwards optional fields to the service', async () => {
    const ingest = getMockIngest();
    ingest.mockResolvedValueOnce({
      ok: true,
      idempotent: false,
      previousState: 'unknown',
      nextState: 'introduced',
      eventId: 'evt-1',
    });
    const app = buildApp();
    await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k',
        decisionId: 'dec-1',
        sourceSurface: 'orb_turn_end',
        occurredAt: '2026-05-11T18:00:00.000Z',
        metadata: { wakeOrigin: 'tap' },
      });
    const call = ingest.mock.calls[0][0];
    expect(call.decisionId).toBe('dec-1');
    expect(call.sourceSurface).toBe('orb_turn_end');
    expect(call.occurredAt).toBe('2026-05-11T18:00:00.000Z');
    expect(call.metadata).toEqual({ wakeOrigin: 'tap' });
  });

  it('rejects invalid sourceSurface silently (drops the field)', async () => {
    const ingest = getMockIngest();
    ingest.mockResolvedValueOnce({
      ok: true,
      idempotent: false,
      previousState: 'unknown',
      nextState: 'introduced',
      eventId: 'evt-1',
    });
    const app = buildApp();
    await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({
        capabilityKey: 'x',
        eventName: 'introduced',
        idempotencyKey: 'k',
        sourceSurface: 'made_up_surface',
      });
    const call = ingest.mock.calls[0][0];
    expect(call.sourceSurface).toBeUndefined();
  });

  it('idempotent replays are mirrored to the client (HTTP 200 + idempotent:true)', async () => {
    getMockIngest().mockResolvedValueOnce({
      ok: true,
      idempotent: true,
      previousState: 'unknown',
      nextState: 'introduced',
      eventId: 'evt-1',
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/voice/feature-discovery/event')
      .send({ capabilityKey: 'x', eventName: 'introduced', idempotencyKey: 'k' });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
  });
});
