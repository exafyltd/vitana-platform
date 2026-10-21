import request from 'supertest';
import express from 'express';

// BOOTSTRAP-ORB-FASTSTART-DRIFT — feature-flag inventory endpoint.
//
// Why this endpoint exists: a flag can be present on a task definition and
// still be dead. `isFeatureLive` maps 'staging-only' → `isStaging`, so a value
// copied from a staging task def evaluates to OFF in production. That is how
// FEATURE_ORB_FAST_START_ENV was lost in the GCP→AWS cutover and stayed lost —
// nothing surfaced the resolved value, so "the var is set" read as "the
// feature is on".

// buildApp() calls jest.resetModules(), which hands the route a FRESH copy of
// this mock — so an implementation set on an imported reference would be
// discarded. Delegate through a stable holder instead (the `mock` prefix is
// what lets the factory close over it).
const mockAdminGuard: { impl: (req: any, res: any, next: any) => void } = {
  impl: (_req, _res, next) => next(),
};

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => mockAdminGuard.impl(req, res, next),
}));

function buildApp() {
  // Required after env mutation — the route module snapshots nothing, but
  // VITANA_ENV is resolved at import time by ../env.
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/admin-health').default;
  const app = express();
  app.use('/api/v1/admin', router);
  return app;
}

const ORIGINAL_ENV = { ...process.env };

describe('GET /api/v1/admin/feature-flags', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockAdminGuard.impl = (_req: any, _res: any, next: any) => next();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('reports the resolved value, not merely whether the var is set', async () => {
    process.env.FEATURE_ORB_FAST_START_ENV = 'staging+prod';
    const res = await request(buildApp()).get('/api/v1/admin/feature-flags');

    expect(res.status).toBe(200);
    const flag = res.body.flags.find((f: any) => f.name === 'ORB_FAST_START');
    expect(flag).toBeDefined();
    expect(flag.setting).toBe('staging+prod');
    expect(flag.live).toBe(true);
    expect(flag.env_var).toBe('FEATURE_ORB_FAST_START_ENV');
    expect(flag.env_var_present).toBe(true);
  });

  it('distinguishes "never configured" from "explicitly off" — the drift signature', async () => {
    delete process.env.FEATURE_ORB_FAST_START_ENV;
    const res = await request(buildApp()).get('/api/v1/admin/feature-flags');
    const missing = res.body.flags.find((f: any) => f.name === 'ORB_FAST_START');
    expect(missing.env_var_present).toBe(false);
    expect(missing.live).toBe(false);

    process.env.FEATURE_ORB_FAST_START_ENV = 'off';
    const res2 = await request(buildApp()).get('/api/v1/admin/feature-flags');
    const explicit = res2.body.flags.find((f: any) => f.name === 'ORB_FAST_START');
    expect(explicit.env_var_present).toBe(true);
    expect(explicit.live).toBe(false);
  });

  it('flags the staging-only-in-production trap that caused the outage', async () => {
    process.env.VITANA_ENV = 'production';
    process.env.FEATURE_ORB_FAST_START_ENV = 'staging-only';
    const res = await request(buildApp()).get('/api/v1/admin/feature-flags');

    const flag = res.body.flags.find((f: any) => f.name === 'ORB_FAST_START');
    // The whole point: the var IS set, and the feature is still dead.
    expect(flag.env_var_present).toBe(true);
    expect(flag.setting).toBe('staging-only');
    expect(flag.live).toBe(false);
    expect(flag.misconfigured_for_env).toBe(true);
  });

  it('does not flag staging-only as misconfigured on staging', async () => {
    process.env.VITANA_ENV = 'staging';
    process.env.FEATURE_ORB_FAST_START_ENV = 'staging-only';
    const res = await request(buildApp()).get('/api/v1/admin/feature-flags');

    const flag = res.body.flags.find((f: any) => f.name === 'ORB_FAST_START');
    expect(flag.misconfigured_for_env).toBe(false);
    expect(flag.live).toBe(true);
  });

  it('is admin-gated', async () => {
    mockAdminGuard.impl = (_req: any, res: any) =>
      res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    const res = await request(buildApp()).get('/api/v1/admin/feature-flags');
    expect(res.status).toBe(403);
  });

  it('keeps the public /health and /build-info responses free of flag data', async () => {
    process.env.FEATURE_ORB_FAST_START_ENV = 'staging+prod';
    const app = buildApp();

    const health = await request(app).get('/api/v1/admin/health');
    expect(health.status).toBe(200);
    expect(health.body.flags).toBeUndefined();

    const build = await request(app).get('/api/v1/admin/build-info');
    expect(build.status).toBe(200);
    expect(build.body.flags).toBeUndefined();
  });
});
