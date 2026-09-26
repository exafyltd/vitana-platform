/**
 * VTID-04641 — /api/v1/testing/results/* routes.
 *
 * Pins: exafy_admin only; the summary returns per-workflow and per-environment
 * health plus the latest STAGING-VERIFY verdict per service; the run list
 * filters; a forced sync reports its error instead of pretending to succeed.
 */
import request from 'supertest';
import express from 'express';

let mockIdentity: { user_id: string; exafy_admin: boolean } | null = { user_id: 'admin-1', exafy_admin: true };
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!mockIdentity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = mockIdentity;
    next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) => {
    if (!req.identity?.exafy_admin) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    next();
  },
}));

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
function from(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let range: [number, number] | null = null;
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return q; },
    gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
    like: (c: string, p: string) => { const re = new RegExp('^' + p.replace(/[.]/g, '\\.').replace(/%/g, '.*') + '$'); filters.push((r) => re.test(r[c])); return q; },
    contains: (c: string, vs: any[]) => { filters.push((r) => vs.every((v) => (r[c] || []).includes(v))); return q; },
    order: () => q,
    range: (a: number, b: number) => { range = [a, b]; return q; },
    limit: (n: number) => { range = [0, n - 1]; return q; },
    then: (ok: any, bad: any) => {
      let out = (db[table] || []).filter((r) => filters.every((f) => f(r)));
      if (range) out = out.slice(range[0], range[1] + 1);
      return Promise.resolve({ data: out, error: null }).then(ok, bad);
    },
  };
  return q;
}
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => ({ from }) }));
jest.mock('../../src/services/github-service', () => ({
  __esModule: true,
  default: { triggerWorkflow: jest.fn(), getWorkflowRuns: jest.fn() },
  listCompletedWorkflowRuns: jest.fn(),
  getWorkflowRunJobs: jest.fn(),
}));

const mockEnsure = jest.fn();
jest.mock('../../src/services/testing/test-results', () => ({
  ...jest.requireActual('../../src/services/testing/test-results'),
  ensureFreshResults: (...a: any[]) => mockEnsure(...a),
}));

import router from '../../src/routes/testing';

const app = express();
app.use('/api/v1/testing', router);

const recent = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
function run(id: number, file: string, conclusion: string, h: number, environments: string[]): Row {
  return {
    repo: 'exafyltd/vitana-platform', run_id: id, run_attempt: 1, workflow_file: file, workflow_name: file, kind: 'test',
    environments, event: 'push', branch: 'main', head_sha: `s${id}`, status: 'completed', conclusion,
    html_url: `https://github.com/x/${id}`, run_created_at: recent(h), duration_s: 60, jobs: [],
  };
}

beforeEach(() => {
  mockIdentity = { user_id: 'admin-1', exafy_admin: true };
  mockEnsure.mockReset().mockResolvedValue({ synced: false });
  db.ci_test_runs = [
    run(1, 'TEST-SUITE.yml', 'failure', 1, ['dev_pr', 'nightly']),
    run(2, 'TEST-SUITE.yml', 'success', 30, ['dev_pr', 'nightly']),
    run(3, 'ALERT-X.yml', 'success', 2, ['production']),
  ];
  db.ci_test_sync_state = [{ repo: 'exafyltd/vitana-platform', last_synced_at: recent(0.01), last_error: null }];
  db.oasis_events = [
    { created_at: recent(0.5), topic: 'staging.verify.passed', metadata: { service: 'gateway', commit: 'abc', run_url: 'u1', results: [{ ok: true, suite: 'smoke', name: 'alive' }] } },
    { created_at: recent(1), topic: 'staging.verify.failed', metadata: { service: 'gateway', commit: 'old', results: [] } },
    { created_at: recent(0.7), topic: 'staging.verify.failed', metadata: { service: 'community-app', commit: 'def', results: [{ ok: false, suite: 'smoke', name: 'boots', problems: ['x'] }] } },
  ];
});

describe('auth', () => {
  it.each([
    ['get', '/api/v1/testing/results/summary'],
    ['get', '/api/v1/testing/results/runs'],
    ['post', '/api/v1/testing/results/sync'],
  ])('%s %s: 401 anonymous, 403 non-admin', async (method, url) => {
    mockIdentity = null;
    expect((await (request(app) as any)[method](url)).status).toBe(401);
    mockIdentity = { user_id: 'u', exafy_admin: false };
    expect((await (request(app) as any)[method](url)).status).toBe(403);
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

describe('GET /results/summary', () => {
  it('returns workflow health, environment roll-ups and the latest STAGING-VERIFY per service', async () => {
    const res = await request(app).get('/api/v1/testing/results/summary');
    expect(res.status).toBe(200);
    expect(res.body.runs).toBe(3);
    expect(res.body.workflows[0]).toMatchObject({ workflow_file: 'TEST-SUITE.yml', health: 'failing', failing_streak: 1 });
    const prod = res.body.environments.find((e: any) => e.environment === 'production');
    expect(prod).toMatchObject({ workflows: 1, passing: 1 });
    const sv = Object.fromEntries(res.body.staging_verify.map((s: any) => [s.service, s]));
    expect(sv.gateway).toMatchObject({ outcome: 'passed', commit: 'abc', tests: 1, failed: [] });
    expect(sv['community-app']).toMatchObject({ outcome: 'failed', failed: [{ suite: 'smoke', name: 'boots', problems: ['x'] }] });
    expect(res.body.sync).toMatchObject({ synced: false, sync_error: null });
  });

  it('still answers from the stored runs when the sync fails', async () => {
    mockEnsure.mockRejectedValue(new Error('test catalog not published'));
    const res = await request(app).get('/api/v1/testing/results/summary');
    expect(res.status).toBe(200);
    expect(res.body.sync.sync_error).toMatch(/not published/);
    expect(res.body.runs).toBe(3);
  });
});

describe('GET /results/runs', () => {
  it('filters by environment, workflow and conclusion', async () => {
    const byEnv = await request(app).get('/api/v1/testing/results/runs?environment=production');
    expect(byEnv.body.runs.map((r: any) => r.run_id)).toEqual([3]);
    const byWf = await request(app).get('/api/v1/testing/results/runs?workflow=TEST-SUITE.yml&conclusion=failure');
    expect(byWf.body.runs.map((r: any) => r.run_id)).toEqual([1]);
  });
});

describe('POST /results/sync', () => {
  it('forces a sync and returns its per-repository results', async () => {
    mockEnsure.mockResolvedValue({ synced: true, results: [{ repo: 'exafyltd/vitana-platform', ingested: 4, error: null }] });
    const res = await request(app).post('/api/v1/testing/results/sync');
    expect(res.status).toBe(200);
    expect(mockEnsure.mock.calls[0][1]).toEqual({ force: true });
    expect(res.body.results[0]).toMatchObject({ ingested: 4 });
  });

  it('answers 503 with the reason when the sync cannot run', async () => {
    mockEnsure.mockRejectedValue(new Error('Supabase not configured'));
    const res = await request(app).post('/api/v1/testing/results/sync');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Supabase/);
  });
});
