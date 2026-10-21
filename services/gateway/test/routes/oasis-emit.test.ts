/**
 * L2.2b.1 (VTID-02987): tests for the `POST /api/v1/oasis/emit` route.
 *
 * Coverage matrix:
 *   1. Missing / malformed Authorization header → 401.
 *   2. Wrong service token → falls back to JWT path → 401.
 *   3. Correct service token + allowed topic → 200, emitOasisEvent called.
 *   4. Correct service token + disallowed topic → 400, NOT emitted.
 *   5. JWT path: optionalAuth identity with `exafy_admin=true` → 200.
 *   6. JWT path: identity present but NOT exafy_admin → 401.
 *   7. Oversized payload (Content-Length above cap) → 413.
 *   8. Invalid body shape (missing topic) → 400.
 *   9. Empty bearer token → 401.
 */

import request from 'supertest';
import express from 'express';

// Mock `emitOasisEvent` BEFORE importing the router so the route picks up
// the mock.
const mockEmit = jest.fn(async () => ({ ok: true, event_id: 'evt-test-1' }));
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => (mockEmit as any)(...args),
}));

// Mock `optionalAuth` so the JWT-path tests can inject identity directly via
// the `Authorization` header value (a simple convention: `Bearer admin-jwt`
// = exafy_admin; `Bearer user-jwt` = ordinary user).
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    const header = String(req.headers?.authorization ?? '');
    if (header === 'Bearer admin-jwt') {
      req.identity = { user_id: 'admin-uid', exafy_admin: true };
    } else if (header === 'Bearer user-jwt') {
      req.identity = { user_id: 'user-uid', exafy_admin: false };
    }
    // Any other value: identity stays undefined (the route returns 401).
    next();
  },
}));

import oasisEmitRouter from '../../src/routes/oasis-emit';

const VALID_TOPIC = 'orb.livekit.agent.starting';
const ALLOWED_LIVEKIT_TOPIC = 'livekit.session.start';
const DISALLOWED_TOPIC = 'orb.live.context.bootstrap'; // wrong prefix

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', oasisEmitRouter);
  return app;
}

beforeEach(() => {
  mockEmit.mockClear();
  mockEmit.mockResolvedValue({ ok: true, event_id: 'evt-test-1' });
  process.env.GATEWAY_SERVICE_TOKEN = 'svc-secret-token-xyz';
});

afterAll(() => {
  delete process.env.GATEWAY_SERVICE_TOKEN;
});

describe('POST /api/v1/oasis/emit — auth gate', () => {
  it('1. missing Authorization → 401, NOT emitted', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/v1/oasis/emit').send({ topic: VALID_TOPIC });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('1b. malformed Authorization (no Bearer prefix) → 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'NotBearer foo')
      .send({ topic: VALID_TOPIC });
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('9. empty bearer token → 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer ')
      .send({ topic: VALID_TOPIC });
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('2. wrong service token AND not a known JWT → 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer wrong-token')
      .send({ topic: VALID_TOPIC });
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('6. JWT path: optionalAuth identity NOT exafy_admin → 401', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer user-jwt')
      .send({ topic: VALID_TOPIC });
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/oasis/emit — topic allowlist', () => {
  it('3. service token + allowed topic → 200, emitOasisEvent called', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: VALID_TOPIC, payload: { room_name: 'orb-test' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.event_id).toBe('evt-test-1');
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.type).toBe(VALID_TOPIC);
    expect(call.source).toBe('orb-agent');
    expect(call.payload).toEqual({ room_name: 'orb-test' });
  });

  it('3b. service token + `livekit.*` topic also allowed', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: ALLOWED_LIVEKIT_TOPIC });
    expect(res.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  // VTID-02992: vtid.live.* matches Vertex's session-lifecycle namespace,
  // which Voice Lab's /api/v1/voice-lab/live/sessions query already filters
  // on. The orb-agent (VTID-02986) emits vtid.live.session.start/stop and
  // vtid.live.stall_detected through this route — they must NOT 400.
  it('3c. service token + `vtid.live.*` topic also allowed (VTID-02992)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: 'vtid.live.session.start', payload: { transport: 'livekit' } });
    expect(res.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].type).toBe('vtid.live.session.start');
  });

  it('4. service token + disallowed topic (orb.live.*) → 400, NOT emitted', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: DISALLOWED_TOPIC });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/orb\.livekit\.|livekit\./);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('4b. service token + arbitrary topic → 400', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: 'arbitrary.forged.event' });
    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('4c. service token + empty topic → 400', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: '' });
    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/oasis/emit — admin-JWT happy path', () => {
  it('5. exafy_admin JWT + allowed topic → 200', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer admin-jwt')
      .send({ topic: VALID_TOPIC, vtid: 'VTID-OPS' });
    expect(res.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.actor_role).toBe('admin');
    expect(call.vtid).toBe('VTID-OPS'); // caller-supplied vtid passes through
  });
});

describe('POST /api/v1/oasis/emit — body shape + size', () => {
  it('8. missing topic → 400', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ payload: {} });
    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('7. payload above 16 KiB cap → 413', async () => {
    // Send a real ~20 KiB body. Express's body parser passes it through (its
    // default cap is 100 KiB), then either the content-length guard OR the
    // post-parse JSON.stringify size check returns 413.
    const app = buildApp();
    const bigPayload = { big: 'x'.repeat(20 * 1024) };
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: VALID_TOPIC, payload: bigPayload });
    expect(res.status).toBe(413);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('7b. payload below cap → 200', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({
        topic: VALID_TOPIC,
        payload: { tiny: 'ok' },
      });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/oasis/emit — emit failure surfaced as 500', () => {
  it('emitOasisEvent returning ok:false → 500', async () => {
    mockEmit.mockResolvedValueOnce({ ok: false, error: 'supabase exploded' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: VALID_TOPIC });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/supabase exploded/);
  });
});

describe('POST /api/v1/oasis/emit — env-misconfig edge', () => {
  it('GATEWAY_SERVICE_TOKEN unset → service-token path NEVER matches (only admin JWT works)', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    const app = buildApp();
    // svc-secret-token-xyz must NOT be accepted when env is unset
    const res = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer svc-secret-token-xyz')
      .send({ topic: VALID_TOPIC });
    expect(res.status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();

    // But admin JWT still works
    const res2 = await request(app)
      .post('/api/v1/oasis/emit')
      .set('Authorization', 'Bearer admin-jwt')
      .send({ topic: VALID_TOPIC });
    expect(res2.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });
});
