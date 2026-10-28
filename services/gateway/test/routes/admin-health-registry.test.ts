import request from 'supertest';
import express from 'express';

// VTID-04087 — GET /api/v1/admin/health-registry.
//
// Before this route, the Command Hub Service Health panel's ~55-entry
// endpoint list lived ONLY inside the Command Hub's static app.js — a new
// health check could ship a route and never appear on the panel unless
// someone remembered to hand-edit that unrelated frontend array too. This
// route makes services/gateway/src/constants/service-health-registry.ts
// the single server-side source of truth; the frontend fetches it at
// runtime and falls back to its own last-known copy only on failure.

function buildApp() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../../src/routes/admin-health').default;
  const app = express();
  app.use('/api/v1/admin', router);
  return app;
}

describe('GET /api/v1/admin/health-registry', () => {
  it('returns 200 with an endpoints array, unauthenticated', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/health-registry');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(res.body.endpoints.length).toBeGreaterThan(0);
  });

  it('every entry has a name, url and group', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/health-registry');
    for (const ep of res.body.endpoints) {
      expect(typeof ep.name).toBe('string');
      expect(ep.name.length).toBeGreaterThan(0);
      expect(typeof ep.url).toBe('string');
      expect(ep.url.startsWith('/')).toBe(true);
      expect(typeof ep.group).toBe('string');
      expect(ep.group.length).toBeGreaterThan(0);
    }
  });

  it('includes the core health checks the panel has always shown', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/health-registry');
    const names = res.body.endpoints.map((ep: any) => ep.name);
    expect(names).toEqual(
      expect.arrayContaining(['Gateway', 'Gateway Alive', 'ORB Live', 'Autopilot', 'VTID', 'Screen Load Time']),
    );
  });

  it('carries no secrets — matches the public /health, /build-info posture', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/health-registry');
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toMatch(/token|secret|key|password/);
  });
});
