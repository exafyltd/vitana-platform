/**
 * VTID-03094 (Teacher PR 4) — POST /api/v1/voice/teacher/event tests.
 */

import express from 'express';
import request from 'supertest';

const emitMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => emitMock(...args),
}));

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

interface FakeOpts {
  rpcResult?: unknown;
  rpcError?: { message: string } | null;
  capRow?: { manual_path: string | null; display_name: string } | null;
}

let fakeOpts: FakeOpts = {};
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => ({
    from: (_t: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: fakeOpts.capRow ?? null, error: null }),
        }),
      }),
    }),
    rpc: async (_fn: string, _args: unknown) => ({
      data: fakeOpts.rpcResult ?? null,
      error: fakeOpts.rpcError ?? null,
    }),
  }),
}));

function buildApp() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/voice-teacher-event').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

describe('VTID-03094 — POST /api/v1/voice/teacher/event', () => {
  beforeEach(() => {
    emitMock.mockClear();
    currentIdentity = FIXED_IDENTITY;
    fakeOpts = {};
  });

  test('401 when identity missing', async () => {
    currentIdentity = null;
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k-1',
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  test('400 when capabilityKey missing', async () => {
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({ eventName: 'introduced', idempotencyKey: 'k-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capabilityKey/);
  });

  test('400 when eventName not allowed', async () => {
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'mastered', // mastered is not allowed via this endpoint
        idempotencyKey: 'k-1',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eventName must be one of/);
  });

  test('400 when idempotencyKey missing', async () => {
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({ capabilityKey: 'life_compass', eventName: 'introduced' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/idempotencyKey/);
  });

  test('happy path: introduced → returns directive + emits OASIS', async () => {
    fakeOpts = {
      rpcResult: {
        ok: true,
        idempotent: false,
        previous_state: 'unknown',
        next_state: 'introduced',
        event_id: 'evt-1',
      },
      capRow: { manual_path: '/manuals/maxina/00-concepts/life-compass', display_name: 'Life Compass' },
    };
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k-1',
        sourceSurface: 'orb_wake',
        decisionId: 'dec-1',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.capability_key).toBe('life_compass');
    expect(res.body.event_name).toBe('introduced');
    expect(res.body.topic).toBe('capability.awareness.introduced');
    expect(res.body.directive).toBeTruthy();
    expect(res.body.directive.route).toBe('/manuals/maxina/00-concepts/life-compass');
    expect(res.body.directive.directive).toBe('navigate');
    // OASIS event fired with the topic from the central registry
    const calls = emitMock.mock.calls.map((c) => c[0] as { type?: string; message?: string });
    const emitted = calls.find((c) => c.type === 'capability.awareness.introduced');
    expect(emitted).toBeDefined();
  });

  test('dismissed: no directive (we do not navigate on dismiss)', async () => {
    fakeOpts = {
      rpcResult: {
        ok: true,
        idempotent: false,
        previous_state: 'introduced',
        next_state: 'dismissed',
        event_id: 'evt-2',
      },
      capRow: { manual_path: '/manuals/...', display_name: 'X' },
    };
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'dismissed',
        idempotencyKey: 'k-2',
      });
    expect(res.status).toBe(200);
    expect(res.body.directive).toBeNull();
    expect(res.body.topic).toBe('capability.awareness.dismissed');
  });

  test('idempotent replay: returns idempotent:true from RPC', async () => {
    fakeOpts = {
      rpcResult: {
        ok: true,
        idempotent: true,
        previous_state: 'unknown',
        next_state: 'introduced',
        event_id: 'evt-existing',
      },
      capRow: { manual_path: '/m', display_name: 'X' },
    };
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'same-key',
      });
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
  });

  test('RPC transition rejected → 409', async () => {
    fakeOpts = {
      rpcResult: {
        ok: false,
        reason: 'transition_not_allowed',
        previous_state: 'mastered',
        attempted_event: 'introduced',
      },
    };
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k-3',
      });
    expect(res.status).toBe(409);
    expect(res.body.rpc_reason).toBe('transition_not_allowed');
  });

  test('RPC error → 502', async () => {
    fakeOpts = {
      rpcError: { message: 'connection lost' },
    };
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k-4',
      });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('rpc_failed');
  });

  test('OASIS emit failure does NOT fail the request', async () => {
    fakeOpts = {
      rpcResult: {
        ok: true,
        idempotent: false,
        previous_state: 'unknown',
        next_state: 'introduced',
        event_id: 'evt-5',
      },
      capRow: { manual_path: '/m', display_name: 'X' },
    };
    emitMock.mockRejectedValueOnce(new Error('OASIS down'));
    const res = await request(buildApp())
      .post('/api/v1/voice/teacher/event')
      .send({
        capabilityKey: 'life_compass',
        eventName: 'introduced',
        idempotencyKey: 'k-5',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
