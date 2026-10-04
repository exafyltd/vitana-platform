/**
 * VTID-04876 — GET /api/v1/ops/attention is exafy_admin only, answers
 * {ok, data:{generated_at, env, verdict, counts, sources, items}}; the real
 * requireAdminAuth rejects a request without a token with 401 JSON.
 * No network, no database: the aggregator runs over fake reads/state.
 */

import express from 'express';
import request from 'supertest';
import { setOpsAttentionDepsForTests } from '../src/services/ops-attention';
import { fakeReads } from './fixtures/ops-attention-fakes';

afterEach(() => setOpsAttentionDepsForTests(null));

describe('GET /api/v1/ops/attention — real auth middleware', () => {
  it('401 JSON without an Authorization header (never reaches the aggregator)', async () => {
    const reads = jest.fn(() => fakeReads());
    setOpsAttentionDepsForTests({ reads, state: () => ({ load: async () => [], save: async () => {} }) });
    const router = require('../src/routes/ops-attention').default;
    const app = express();
    app.use('/api/v1/ops/attention', router);
    const res = await request(app).get('/api/v1/ops/attention');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/ops/attention — admin (middleware mocked)', () => {
  function appWithAdmin(isAdmin: boolean) {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      requireAdminAuth: (req: any, res: any, next: any) =>
        isAdmin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const svc = require('../src/services/ops-attention');
    svc.setOpsAttentionDepsForTests({
      reads: () => fakeReads({ supervisorAlerts: async () => [{ severity: 'critical', text: 'LLM providers are failing', tab: 'live' }] }),
      state: () => ({ load: async () => [], save: async () => {} }),
    });
    const router = require('../src/routes/ops-attention').default;
    const app = express();
    app.use('/api/v1/ops/attention', router);
    return { app, svc };
  }

  afterEach(() => {
    jest.dontMock('../src/middleware/auth-supabase-jwt');
  });

  it('200 {ok, data} with the contract shape for an exafy_admin', async () => {
    const { app, svc } = appWithAdmin(true);
    const res = await request(app).get('/api/v1/ops/attention').set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const d = res.body.data;
    expect(Object.keys(d).sort()).toEqual(['counts', 'env', 'generated_at', 'items', 'sources', 'verdict']);
    expect(d.env).toBe('production');
    expect(d.counts).toEqual({ p1: 0, p2: 1, p3: 1 });
    expect(d.items[0]).toMatchObject({ severity: 'P2', domain: 'autonomy', source: 'autonomy', deeplink: { section: 'autopilot', tab: 'live', query: {} } });
    expect(d.sources.map((s: any) => s.id)).toContain('decisions_waiting');
    expect(res.headers['cache-control']).toBe('no-store');
    svc.setOpsAttentionDepsForTests(null);
  });

  it('a non-admin is refused by the gate', async () => {
    const { app, svc } = appWithAdmin(false);
    const res = await request(app).get('/api/v1/ops/attention');
    expect(res.status).toBe(403);
    svc.setOpsAttentionDepsForTests(null);
  });
});

describe('index.ts mounts the route like its neighbours', () => {
  it('mountRouterSync at /api/v1/ops/attention with owner ops-attention', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/index.ts'), 'utf8');
    expect(src).toContain("const opsAttentionRouter = require('./routes/ops-attention').default;");
    expect(src).toContain("mountRouterSync(app, '/api/v1/ops/attention', opsAttentionRouter, { owner: 'ops-attention' });");
  });
});
