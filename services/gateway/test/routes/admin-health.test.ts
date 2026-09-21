import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import express from 'express';

/**
 * /api/v1/admin/health, /build-info, /health-registry — the three
 * deliberately-public diagnostic surfaces of the admin-health router.
 *
 * Why this suite exists: `route-auth-scanner-v1` flagged
 * admin-health.ts for a handler with "no auth middleware", because the
 * `/health` and `/build-info` handlers carry no auth call — which is the
 * point (file header, lines 1-17): they are the endpoints the post-deploy
 * smoke `curl`s to prove a new revision is live, and an operator curls
 * from a phone to tell staging from prod. They carry no secrets, only
 * environment identity.
 *
 * The scanner's opt-out sentinel is a `// public-route` comment on (or
 * within 5 lines above) the handler. `/health-registry` already had one;
 * `/health` and `/build-info` did not, so they were reported as gaps. This
 * suite asserts BOTH halves of the fix so the annotation cannot silently
 * drift away again:
 *   1. the endpoints really are public (they answer 200 with no
 *      Authorization header) and really do refuse to carry secrets;
 *   2. the `// public-route` sentinel is present where the scanner looks
 *      for it, for all three handlers — and the auth-gated siblings still
 *      reject an unauthenticated caller.
 */

const SOURCE_PATH = path.join(__dirname, '..', '..', 'src', 'routes', 'admin-health.ts');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

/**
 * Mirrors route-auth-scanner-v1's hasPublicSentinel(): walks back up to 5
 * lines from the `router.<verb>('<route>'` call site and looks for the
 * opt-out marker. Kept intentionally a copy of the scanner's own rule
 * (scripts/ci/scanners/route-auth.mjs) rather than a looser "the file
 * mentions public-route somewhere" check — that looser check passes even
 * when the comment sits above the wrong handler.
 */
function hasPublicSentinelNearRoute(route: string): boolean {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Matches both the one-line form `router.get('/x', ...)` and the
  // split-argument form `router.get(\n  '/x',\n  requireAdminAuth,`.
  const call = new RegExp(`router\\.get\\(\\s*'${escaped}'`).exec(SOURCE);
  if (!call) throw new Error(`router.get('${route}') not found in ${SOURCE_PATH}`);

  const lineStart = SOURCE.lastIndexOf('\n', call.index) + 1;
  const lines = SOURCE.slice(0, lineStart).split('\n');
  const lookBack = lines.slice(Math.max(0, lines.length - 6));
  return lookBack.some((line) => /\/\/\s*public[-\s]?route\b/i.test(line));
}

function buildApp() {
  // Same resetModules + require pattern as the sibling admin-health suites:
  // the router is re-required per call so `../env` (resolved at import time)
  // is read fresh.
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/admin-health').default;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', router);
  return app;
}

describe('admin-health public diagnostic routes', () => {
  describe('GET /api/v1/admin/health', () => {
    it('returns 200 unauthenticated with the environment-identity shape', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        env: expect.any(String),
      });
      // Every field the post-deploy smoke reads. `supabase_host` is a
      // hostname only (no scheme/path/key) and the Cloud Run fields are null
      // outside Cloud Run, so assert presence, not value.
      for (const field of [
        'supabase_host',
        'cloud_run_service',
        'cloud_run_revision',
        'booted_at',
      ]) {
        expect(res.body).toHaveProperty(field);
      }
      expect(typeof res.body.booted_at).toBe('string');
    });

    it('carries no secrets', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/health');
      const raw = JSON.stringify(res.body).toLowerCase();
      expect(raw).not.toMatch(/token|secret|password|service_role/);
    });
  });

  describe('GET /api/v1/admin/build-info', () => {
    it('returns 200 unauthenticated with the revision shape', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/build-info');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        env: expect.any(String),
      });
      // git_commit / marker are null when the build env vars are unset
      // (including in tests), so assert presence, not a value.
      for (const field of [
        'cloud_run_service',
        'cloud_run_revision',
        'git_commit',
        'booted_at',
        'marker',
      ]) {
        expect(res.body).toHaveProperty(field);
      }
      expect(typeof res.body.booted_at).toBe('string');
    });

    it('carries no secrets', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/build-info');
      const raw = JSON.stringify(res.body).toLowerCase();
      expect(raw).not.toMatch(/token|secret|password|service_role/);
    });
  });

  describe('GET /api/v1/admin/health-registry', () => {
    it('returns 200 unauthenticated with the endpoint list', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/health-registry');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.endpoints)).toBe(true);
      expect(res.body.endpoints.length).toBeGreaterThan(0);
    });
  });

  describe('auth-gated siblings still reject anonymous callers', () => {
    it('GET /api/v1/admin/feature-flags returns 401 without an Authorization header', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/feature-flags');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    });

    it('GET /api/v1/admin/orb-session-state-health returns 401 without an Authorization header', async () => {
      const res = await request(buildApp()).get('/api/v1/admin/orb-session-state-health');

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    });
  });

  describe('scanner opt-out annotations (route-auth-scanner-v1)', () => {
    it.each(['/health', '/build-info', '/health-registry'])(
      'has a `// public-route` sentinel within the scanner look-back window for %s',
      (route) => {
        expect(hasPublicSentinelNearRoute(route)).toBe(true);
      },
    );

    it('does not annotate the auth-gated handlers as public', () => {
      expect(hasPublicSentinelNearRoute('/feature-flags')).toBe(false);
      expect(hasPublicSentinelNearRoute('/orb-session-state-health')).toBe(false);
      expect(hasPublicSentinelNearRoute('/aurora-rls-health')).toBe(false);
    });
  });
});
