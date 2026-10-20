/**
 * VTID-05216 — GET /api/v1/project-manager/status (read-only).
 * Returns the PM mode and the current (last tick's) decision list; auth is the
 * service token or an exafy_admin JWT (requireServiceOrAdmin).
 */

import express from 'express';
import request from 'supertest';
import { createProjectManagerRouter } from '../../src/routes/project-manager';
import { PmStatusSnapshot } from '../../src/services/project-manager';

const SERVICE_TOKEN = 'test-pm-service-token';

function appWith(snapshot: PmStatusSnapshot) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/project-manager', createProjectManagerRouter(() => snapshot));
  return app;
}

const snapshot: PmStatusSnapshot = {
  mode: 'dry_run',
  last_tick_at: '2026-10-15T12:00:00.000Z',
  decisions: [
    { kind: 'merge', slug: 'pm-agent', lane: 'p3-observe-decide', vtid: 'VTID-05216', pr_url: 'u', head_sha: 'h' },
  ],
};

describe('GET /status auth', () => {
  const prev = process.env.GATEWAY_SERVICE_TOKEN;
  beforeAll(() => { process.env.GATEWAY_SERVICE_TOKEN = SERVICE_TOKEN; });
  afterAll(() => {
    if (prev === undefined) delete process.env.GATEWAY_SERVICE_TOKEN;
    else process.env.GATEWAY_SERVICE_TOKEN = prev;
  });

  it('401 without a bearer token', async () => {
    const res = await request(appWith(snapshot)).get('/api/v1/project-manager/status');
    expect(res.status).toBe(401);
  });

  it('401 with a wrong service token', async () => {
    const res = await request(appWith(snapshot))
      .get('/api/v1/project-manager/status')
      .set('Authorization', 'Bearer not-the-token');
    expect(res.status).toBe(401);
  });

  it('200 with the service token, returns mode + decisions', async () => {
    const res = await request(appWith(snapshot))
      .get('/api/v1/project-manager/status')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      mode: 'dry_run',
      last_tick_at: '2026-10-15T12:00:00.000Z',
    });
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0]).toMatchObject({ kind: 'merge', vtid: 'VTID-05216' });
    expect(typeof res.body.enabled).toBe('boolean');
  });
});

// VTID-05274 T24: /status carries the fallback detail; /mode is public and minimal.
describe('T24 /status fallback fields and the public /mode', () => {
  const prev = process.env.GATEWAY_SERVICE_TOKEN;
  beforeAll(() => { process.env.GATEWAY_SERVICE_TOKEN = SERVICE_TOKEN; });
  afterAll(() => {
    if (prev === undefined) delete process.env.GATEWAY_SERVICE_TOKEN;
    else process.env.GATEWAY_SERVICE_TOKEN = prev;
  });

  const fallbackSnap: PmStatusSnapshot = {
    ...snapshot,
    mode: 'live',
    claude: { available: false, reason: 'flag_false' },
    fallback: true,
    build_lanes_in_flight: { 'kiro-autonomy-fallback': 3 },
    last_lease: 'acquired',
  };

  it('/status with the token carries claude, fallback, build_lanes_in_flight, last_lease', async () => {
    const res = await request(appWith(fallbackSnap))
      .get('/api/v1/project-manager/status')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.claude).toEqual({ available: false, reason: 'flag_false' });
    expect(res.body.fallback).toBe(true);
    expect(res.body.build_lanes_in_flight).toEqual({ 'kiro-autonomy-fallback': 3 });
    expect(res.body.last_lease).toBe('acquired');
  });

  it('/status defaults: Claude available, no fallback, last_lease null', async () => {
    const res = await request(appWith(snapshot))
      .get('/api/v1/project-manager/status')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`);
    expect(res.body.claude).toEqual({ available: true, reason: null });
    expect(res.body.fallback).toBe(false);
    expect(res.body.last_lease).toBeNull();
  });

  it('/status without a token → 401', async () => {
    const res = await request(appWith(fallbackSnap)).get('/api/v1/project-manager/status');
    expect(res.status).toBe(401);
  });

  it('/mode without a token → 200 with exactly ok, enabled, mode, executor_mode', async () => {
    const res = await request(appWith(fallbackSnap)).get('/api/v1/project-manager/mode');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['enabled', 'executor_mode', 'mode', 'ok']);
    expect(res.body).toMatchObject({ ok: true, mode: 'live', executor_mode: 'kiro_fallback' });
    expect(res.body).not.toHaveProperty('claude_available');
    expect(res.body).not.toHaveProperty('claude_reason');
  });

  it('/mode reports claude_primary when Claude is available', async () => {
    const res = await request(appWith(snapshot)).get('/api/v1/project-manager/mode');
    expect(res.body.executor_mode).toBe('claude_primary');
  });
});
