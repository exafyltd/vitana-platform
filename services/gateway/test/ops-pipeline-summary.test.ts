/**
 * VTID-04887 — GET /api/v1/ops/pipeline-summary (plan A, Phase 4, Q6).
 *
 * The Command Hub's Operator Dashboard and Runbook read the pipeline summary.
 * /api/v1/autopilot/pipeline/summary needs the service token, so every
 * browser call was a 401. This route serves the same body in-process through
 * buildPipelineSummary(), behind requireAdminAuth.
 *
 * No network, no database: the builder is mocked except in the
 * "same body as the service-token route" case, which runs both routes over
 * the jest fetch mock.
 */

import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SAMPLE_BODY = {
  ok: true,
  timestamp: '2026-10-05T10:00:00.000Z',
  funnel: { scheduled: 1, in_progress: 2, completed: 3 },
  attention_queue: [{ vtid: 'VTID-04000', severity: 'STUCK', title: 't', stuck_minutes: 90, reason: 'r' }],
};

function appWith(opts: { isAdmin: boolean; build: jest.Mock }) {
  jest.resetModules();
  jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
    requireAdminAuth: (_req: any, res: any, next: any) =>
      opts.isAdmin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
  }));
  jest.doMock('../src/services/pipeline-summary-builder', () => ({ buildPipelineSummary: opts.build }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../src/routes/ops-pipeline-summary');
  mod.resetOpsPipelineSummaryCacheForTests();
  const app = express();
  app.use('/api/v1/ops/pipeline-summary', mod.default);
  return { app, mod };
}

afterEach(() => {
  jest.dontMock('../src/middleware/auth-supabase-jwt');
  jest.dontMock('../src/services/pipeline-summary-builder');
});

describe('GET /api/v1/ops/pipeline-summary — real auth middleware', () => {
  it('401 JSON without an Authorization header; the builder never runs', async () => {
    jest.resetModules();
    const build = jest.fn();
    jest.doMock('../src/services/pipeline-summary-builder', () => ({ buildPipelineSummary: build }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/ops-pipeline-summary').default;
    const app = express();
    app.use('/api/v1/ops/pipeline-summary', router);
    const res = await request(app).get('/api/v1/ops/pipeline-summary');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    expect(build).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/ops/pipeline-summary — admin (middleware mocked)', () => {
  it('200 with exactly the builder body for an exafy_admin', async () => {
    const build = jest.fn(async () => ({ status: 200, body: SAMPLE_BODY }));
    const { app } = appWith({ isAdmin: true, build });
    const res = await request(app).get('/api/v1/ops/pipeline-summary').set('Authorization', 'Bearer admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SAMPLE_BODY);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-pipeline-summary-cache']).toBe('miss');
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith();
  });

  it('a non-admin is refused by the gate and the builder never runs', async () => {
    const build = jest.fn();
    const { app } = appWith({ isAdmin: false, build });
    const res = await request(app).get('/api/v1/ops/pipeline-summary').set('Authorization', 'Bearer member');
    expect(res.status).toBe(403);
    expect(build).not.toHaveBeenCalled();
  });

  it('a second request inside 15 s is served from the cache', async () => {
    const build = jest.fn(async () => ({ status: 200, body: SAMPLE_BODY }));
    const { app } = appWith({ isAdmin: true, build });
    await request(app).get('/api/v1/ops/pipeline-summary');
    const res = await request(app).get('/api/v1/ops/pipeline-summary');
    expect(res.status).toBe(200);
    expect(res.headers['x-pipeline-summary-cache']).toBe('hit');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('concurrent requests share one builder run (single-flight)', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    const build = jest.fn(async () => { await gate; return { status: 200, body: SAMPLE_BODY }; });
    const { app } = appWith({ isAdmin: true, build });
    const a = request(app).get('/api/v1/ops/pipeline-summary').then((r) => r);
    const b = request(app).get('/api/v1/ops/pipeline-summary').then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    release(null);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('a builder error (500) is passed through and never cached', async () => {
    const build = jest
      .fn()
      .mockResolvedValueOnce({ status: 500, body: { ok: false, error: 'boom' } })
      .mockResolvedValueOnce({ status: 200, body: SAMPLE_BODY });
    const { app } = appWith({ isAdmin: true, build });
    const first = await request(app).get('/api/v1/ops/pipeline-summary');
    expect(first.status).toBe(500);
    expect(first.body).toEqual({ ok: false, error: 'boom' });
    const second = await request(app).get('/api/v1/ops/pipeline-summary');
    expect(second.status).toBe(200);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('a throwing builder still answers JSON 500 with a snake_case error code', async () => {
    const build = jest.fn(async () => { throw new Error('unexpected'); });
    const { app } = appWith({ isAdmin: true, build });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/v1/ops/pipeline-summary');
    errSpy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'pipeline_summary_failed' });
  });
});

describe('the service-token route is unchanged for machine callers', () => {
  const AUTOPILOT = readFileSync(join(__dirname, '../src/routes/autopilot.ts'), 'utf8');
  it('/pipeline/summary still sits behind requireServiceToken and calls the same builder', () => {
    expect(AUTOPILOT).toContain('router.use(requireServiceToken);');
    expect(AUTOPILOT).toContain("router.get('/pipeline/summary', async (_req: Request, res: Response) => {");
    expect(AUTOPILOT).toContain('const { status, body } = await buildPipelineSummary();');
    // The exemption list did not grow: /pipeline/summary is not exempt.
    expect(AUTOPILOT).not.toMatch(/req\.path === "\/pipeline\/summary"/);
  });

  it('the new route calls the same in-process builder, never an HTTP self-call', () => {
    const src = readFileSync(join(__dirname, '../src/routes/ops-pipeline-summary.ts'), 'utf8');
    expect(src).toContain("from '../services/pipeline-summary-builder'");
    expect(src).toContain('buildPipelineSummary()');
    expect(src).toContain("router.get('/', requireAdminAuth,");
    // Code lines only: the header comment names the old URL on purpose.
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toContain('/api/v1/autopilot');
  });
});

describe('index.ts mounts the route like its neighbours', () => {
  it('mountRouterSync at /api/v1/ops/pipeline-summary with owner ops-pipeline-summary', () => {
    const src = readFileSync(join(__dirname, '../src/index.ts'), 'utf8');
    expect(src).toContain("const opsPipelineSummaryRouter = require('./routes/ops-pipeline-summary').default;");
    expect(src).toContain(
      "mountRouterSync(app, '/api/v1/ops/pipeline-summary', opsPipelineSummaryRouter, { owner: 'ops-pipeline-summary' });",
    );
  });

  it('the developer domain atlas claims the new route file', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { domainsForRoute } = require('../src/orb/developer/domain-atlas');
    expect(domainsForRoute('ops-pipeline-summary').length).toBeGreaterThan(0);
  });
});
