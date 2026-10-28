/**
 * Admin-gate + validation test for POST /api/v1/admin/orb-tools/selfcheck.
 *
 * The self-check runs ORB tools against an arbitrary user's data, so it MUST be
 * admin-only. This suite mounts the REAL router with the REAL requireExafyAdmin
 * guard (signing JWTs against a test secret) and asserts the security +
 * validation contract without dragging in Supabase or the tool dispatcher:
 *   1. unauthenticated      → 401
 *   2. authenticated non-admin → 403
 *   3. admin + missing user_id → 400 (validation, before any DB work)
 *   4. admin + user_id      → reaches the handler (NOT 401/403)
 */

import express from 'express';
import request from 'supertest';
import * as jose from 'jose';

const TEST_SECRET = 'test-supabase-jwt-secret-for-orb-tools-selfcheck';
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
// Ensure the handler hits its own getSupabase()/validation paths, not a real DB.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import selfcheckRouter from '../src/routes/orb-tools-selfcheck';

async function signToken(opts: { exafyAdmin: boolean }): Promise<string> {
  const key = new TextEncoder().encode(TEST_SECRET);
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    email: 'caller@example.com',
    app_metadata: {
      active_tenant_id: '00000000-0000-0000-0000-000000000001',
      exafy_admin: opts.exafyAdmin,
    },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('11111111-1111-1111-1111-111111111111')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/orb-tools', selfcheckRouter);
  return app;
}

describe('POST /api/v1/admin/orb-tools/selfcheck — admin gate + validation', () => {
  const app = makeApp();

  it('rejects an unauthenticated caller with 401', async () => {
    const res = await request(app).post('/api/v1/admin/orb-tools/selfcheck').send({ user_id: 'u1' });
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated non-admin caller with 403', async () => {
    const token = await signToken({ exafyAdmin: false });
    const res = await request(app)
      .post('/api/v1/admin/orb-tools/selfcheck')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: 'u1' });
    expect(res.status).toBe(403);
  });

  it('admin + missing user_id → 400 (validated before any DB work)', async () => {
    const token = await signToken({ exafyAdmin: true });
    const res = await request(app)
      .post('/api/v1/admin/orb-tools/selfcheck')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/user_id/);
  });

  it('admin + user_id → passes the guard (reaches handler, not 401/403)', async () => {
    const token = await signToken({ exafyAdmin: true });
    const res = await request(app)
      .post('/api/v1/admin/orb-tools/selfcheck')
      .set('Authorization', `Bearer ${token}`)
      .send({ user_id: '22222222-2222-2222-2222-222222222222' });
    expect([200, 503]).toContain(res.status); // 503 when Supabase isn't configured in the test env
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
