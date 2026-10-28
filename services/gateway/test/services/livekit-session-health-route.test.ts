/**
 * BOOTSTRAP-LIVEKIT-CONTROL — admin-gate test for
 * GET /api/v1/orb/livekit/sessions/health.
 *
 * The session-health summary returns cross-tenant user_ids, so it MUST be
 * admin-only. The route is guarded by the canonical `requireAdminAuth`
 * middleware (auth + exafy_admin). This suite exercises that real guard —
 * NOT a pass-through mock — to prove that:
 *   1. an unauthenticated caller is rejected with 401,
 *   2. an authenticated but non-admin caller is rejected with 403,
 *   3. an exafy_admin caller passes the guard and reaches the handler.
 *
 * To keep the test fast and hermetic it mounts the REAL `requireAdminAuth`
 * middleware (the exact guard the route uses) on the same path + handler
 * shape, signing JWTs against a test SUPABASE_JWT_SECRET. This verifies the
 * security contract without dragging in the full orb-livekit router graph
 * (livekit-server-sdk, orb-live, etc.).
 */

import express, { Response } from 'express';
import request from 'supertest';
import * as jose from 'jose';

const TEST_SECRET = 'test-supabase-jwt-secret-for-livekit-session-health';

// Set the secret BEFORE importing the auth middleware so getJwtSecrets()
// picks it up at verify time. (The middleware reads process.env per-call,
// but setting it up-front keeps intent obvious.)
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

import {
  requireAdminAuth,
  AuthenticatedRequest,
} from '../../src/middleware/auth-supabase-jwt';

// resolveVitanaId in requireAdminAuth does a best-effort app_users lookup that
// is null-tolerant; getSupabase() returns null without config so it no-ops.

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

function buildApp() {
  const app = express();
  app.use(express.json());
  // Mirror the production wiring: requireAdminAuth guards the route, and the
  // handler keeps the in-handler exafy_admin defense-in-depth check.
  app.get(
    '/api/v1/orb/livekit/sessions/health',
    requireAdminAuth,
    (req: AuthenticatedRequest, res: Response) => {
      if (!req.identity?.exafy_admin) {
        return res.status(403).json({
          ok: false,
          error: 'exafy_admin role required for session-health summary',
        });
      }
      return res.json({ ok: true, reached_handler: true });
    },
  );
  return app;
}

describe('GET /api/v1/orb/livekit/sessions/health — admin gate', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await request(buildApp()).get('/api/v1/orb/livekit/sessions/health');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('rejects an invalid/garbage token with 401', async () => {
    const res = await request(buildApp())
      .get('/api/v1/orb/livekit/sessions/health')
      .set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('rejects an authenticated NON-admin caller with 403', async () => {
    const token = await signToken({ exafyAdmin: false });
    const res = await request(buildApp())
      .get('/api/v1/orb/livekit/sessions/health')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('allows an exafy_admin caller through the guard to the handler', async () => {
    const token = await signToken({ exafyAdmin: true });
    const res = await request(buildApp())
      .get('/api/v1/orb/livekit/sessions/health')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reached_handler).toBe(true);
  });
});
