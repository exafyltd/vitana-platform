// VTID-04407 / VTID-04408 — /api/v1/dev-memory routes.
import express from 'express';
import request from 'supertest';

let admin: any = { user_id: '11111111-1111-4111-8111-111111111111', exafy_admin: true };
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => {
    if (!admin) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = admin; next();
  },
}));
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue(undefined) }));
const buildMorningPack = jest.fn();
jest.mock('../../src/services/dev-memory/morning-pack', () => ({ buildMorningPack: (...a: any[]) => buildMorningPack(...a) }));
const runHandoffSweep = jest.fn();
jest.mock('../../src/services/dev-memory/handoff', () => ({ runHandoffSweep: (...a: any[]) => runHandoffSweep(...a) }));

const PACK_TOKEN = 'p'.repeat(32);
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/dev-memory', require('../../src/routes/dev-memory').default);
  return a;
}

beforeEach(() => {
  admin = { user_id: '11111111-1111-4111-8111-111111111111', exafy_admin: true };
  process.env.DEV_MEMORY_PACK_TOKEN = PACK_TOKEN;
  process.env.GATEWAY_INTERNAL_TOKEN = 'i'.repeat(32);
  buildMorningPack.mockReset().mockResolvedValue({ ok: true, pack: { text: 'PACK TEXT', handoffs: [] } });
  runHandoffSweep.mockReset().mockResolvedValue({ candidates: 1, outcomes: { written: 1 }, written: 1 });
});

describe('GET /morning-pack', () => {
  it('an admin session gets its own handoffs', async () => {
    const res = await request(app()).get('/api/v1/dev-memory/morning-pack');
    expect(res.status).toBe(200);
    expect(buildMorningPack.mock.calls[0][0]).toEqual({ repo: 'vitana-platform', authorUserId: admin.user_id });
  });

  it('the pack token works without a session and can name an author', async () => {
    admin = null;
    const res = await request(app()).get('/api/v1/dev-memory/morning-pack?repo=vitana-v1&author_user_id=22222222-2222-4222-8222-222222222222&format=text')
      .set('X-Dev-Memory-Token', PACK_TOKEN);
    expect(res.status).toBe(200);
    expect(res.text).toBe('PACK TEXT');
    expect(buildMorningPack.mock.calls[0][0]).toEqual({ repo: 'vitana-v1', authorUserId: '22222222-2222-4222-8222-222222222222' });
  });

  it('rejects a wrong token, a short configured token, and a malformed author', async () => {
    admin = null;
    expect((await request(app()).get('/api/v1/dev-memory/morning-pack').set('X-Dev-Memory-Token', 'wrong')).status).toBe(401);
    process.env.DEV_MEMORY_PACK_TOKEN = 'short';
    expect((await request(app()).get('/api/v1/dev-memory/morning-pack').set('X-Dev-Memory-Token', 'short')).status).toBe(401);
    process.env.DEV_MEMORY_PACK_TOKEN = PACK_TOKEN;
    expect((await request(app()).get('/api/v1/dev-memory/morning-pack?author_user_id=x').set('X-Dev-Memory-Token', PACK_TOKEN)).status).toBe(400);
  });

  it('503 when the pack cannot be built', async () => {
    buildMorningPack.mockResolvedValue({ ok: false, error: 'unavailable' });
    expect((await request(app()).get('/api/v1/dev-memory/morning-pack')).status).toBe(503);
  });
});

describe('POST /handoffs/sweep', () => {
  it('runs with the internal token', async () => {
    admin = null;
    const res = await request(app()).post('/api/v1/dev-memory/handoffs/sweep').set('X-Gateway-Internal', 'i'.repeat(32));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, written: 1 });
  });

  it('the read-only pack token cannot trigger writes', async () => {
    admin = null;
    const res = await request(app()).post('/api/v1/dev-memory/handoffs/sweep').set('X-Dev-Memory-Token', PACK_TOKEN);
    expect(res.status).toBe(401);
    expect(runHandoffSweep).not.toHaveBeenCalled();
  });
});
