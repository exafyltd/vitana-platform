/**
 * VTID-04643 — /api/v1/testing/launchable, /launch, /launches.
 *
 * Pins: exafy_admin only; nothing off the launch list is dispatched; a reason
 * is required; staging E2E goes out read-only against staging; STAGING-VERIFY
 * is pinned to the commit staging serves; vitana-v1 needs its own token; every
 * launch is recorded in OASIS with the verified caller, never a body field.
 */
import request from 'supertest';
import express from 'express';

let mockIdentity: { user_id: string; email: string | null; exafy_admin: boolean } | null = null;
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

const mockTrigger = jest.fn();
jest.mock('../../src/services/github-service', () => ({
  __esModule: true,
  default: { triggerWorkflow: (...a: any[]) => mockTrigger(...a), getWorkflowRuns: jest.fn() },
  listCompletedWorkflowRuns: jest.fn(),
  getWorkflowRunJobs: jest.fn(),
}));
const mockEmit = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: any[]) => mockEmit(...a) }));

const events: any[] = [];
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => ({
    from: () => {
      const q: any = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        then: (ok: any) => Promise.resolve({ data: events, error: null }).then(ok),
      };
      return q;
    },
  }),
}));
jest.mock('../../src/services/testing/test-catalog', () => ({
  ...jest.requireActual('../../src/services/testing/test-catalog'),
  loadTestCatalog: async () => ({ catalog: { workflows: [{ repo: 'exafyltd/vitana-platform', file: 'TEST-SUITE.yml', kind: 'test', environments: ['dev_pr'], flags: [], manual_trigger: true }] }, fromCache: true, source: 'test' }),
}));

import router from '../../src/routes/testing';

const app = express();
app.use(express.json());
app.use('/api/v1/testing', router);

const SHA = 'b'.repeat(40);
const realFetch = global.fetch;

beforeEach(() => {
  mockIdentity = { user_id: 'admin-1', email: 'admin@example.test', exafy_admin: true };
  mockTrigger.mockReset().mockResolvedValue(undefined);
  mockEmit.mockReset().mockResolvedValue({ ok: true });
  events.length = 0;
  delete process.env.FRONTEND_DEPLOY_TOKEN;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ git_commit: SHA }) })) as any;
});
afterAll(() => { global.fetch = realFetch; });

describe('auth', () => {
  it.each([
    ['get', '/api/v1/testing/launchable'],
    ['post', '/api/v1/testing/launch'],
    ['get', '/api/v1/testing/launches'],
  ])('%s %s: 401 anonymous, 403 non-admin, nothing dispatched', async (method, url) => {
    mockIdentity = null;
    expect((await (request(app) as any)[method](url)).status).toBe(401);
    mockIdentity = { user_id: 'u', email: null, exafy_admin: false };
    expect((await (request(app) as any)[method](url)).status).toBe(403);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe('POST /launch', () => {
  it('refuses a deploy workflow and dispatches nothing', async () => {
    const res = await request(app).post('/api/v1/testing/launch').send({ repo: 'exafyltd/vitana-platform', workflow: 'AWS-PROD-DEPLOY-GATEWAY.yml', reason: 'ship it please' });
    expect(res.status).toBe(403);
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('requires a reason', async () => {
    const res = await request(app).post('/api/v1/testing/launch').send({ repo: 'exafyltd/vitana-platform', workflow: 'TEST-SUITE.yml' });
    expect(res.status).toBe(400);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('dispatches a listed workflow on main and records who started it and why', async () => {
    const res = await request(app).post('/api/v1/testing/launch').send({
      repo: 'exafyltd/vitana-platform', workflow: 'TEST-SUITE.yml', reason: 'check main after merge', actor: 'someone-else',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'dispatched', environment: 'dev_pr' });
    expect(mockTrigger).toHaveBeenCalledWith('exafyltd/vitana-platform', 'TEST-SUITE.yml', 'main', {}, undefined);
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'testing.run.launched', actor_id: 'admin-1', actor_email: 'admin@example.test',
      payload: expect.objectContaining({ workflow: 'TEST-SUITE.yml', reason: 'check main after merge', environment: 'dev_pr' }),
    }));
  });

  it('sends staging E2E read-only against the staging app, whatever the body says', async () => {
    const res = await request(app).post('/api/v1/testing/launch').send({
      repo: 'exafyltd/vitana-platform', workflow: 'E2E-TEST-RUN.yml', reason: 'smoke the hub', projects: ['hub-shared'],
      community_url: 'https://vitanaland.com', read_only: false,
    });
    expect(res.status).toBe(200);
    expect(mockTrigger).toHaveBeenCalledWith('exafyltd/vitana-platform', 'E2E-TEST-RUN.yml', 'main',
      { projects: 'hub-shared', community_url: 'https://preview-aws.vitanaland.com', read_only: 'true' }, undefined);
  });

  it('pins STAGING-VERIFY to the commit staging serves, and refuses when it cannot read one', async () => {
    const ok = await request(app).post('/api/v1/testing/launch').send({ repo: 'exafyltd/vitana-platform', workflow: 'STAGING-VERIFY.yml', reason: 're-verify staging' });
    expect(ok.status).toBe(200);
    expect(mockTrigger).toHaveBeenCalledWith('exafyltd/vitana-platform', 'STAGING-VERIFY.yml', 'main', { service: 'gateway', commit_sha: SHA }, undefined);
    mockTrigger.mockClear();
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) })) as any;
    const bad = await request(app).post('/api/v1/testing/launch').send({ repo: 'exafyltd/vitana-platform', workflow: 'STAGING-VERIFY.yml', reason: 're-verify staging' });
    expect(bad.status).toBe(503);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('starts vitana-v1 workflows only with the frontend token', async () => {
    const body = { repo: 'exafyltd/vitana-v1', workflow: 'UNIT-TESTS.yml', reason: 'frontend check' };
    expect((await request(app).post('/api/v1/testing/launch').send(body)).status).toBe(503);
    expect(mockTrigger).not.toHaveBeenCalled();
    process.env.FRONTEND_DEPLOY_TOKEN = 'tok';
    expect((await request(app).post('/api/v1/testing/launch').send(body)).status).toBe(200);
    expect(mockTrigger).toHaveBeenCalledWith('exafyltd/vitana-v1', 'UNIT-TESTS.yml', 'main', {}, 'tok');
  });

  it('reports a GitHub failure as 502 and records no launch', async () => {
    mockTrigger.mockRejectedValue(new Error('GitHub API error: 403 - Forbidden'));
    const res = await request(app).post('/api/v1/testing/launch').send({ repo: 'exafyltd/vitana-platform', workflow: 'TEST-SUITE.yml', reason: 'check main' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/403/);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('GET /launchable and /launches', () => {
  it('lists the launch list with the E2E projects', async () => {
    const res = await request(app).get('/api/v1/testing/launchable');
    expect(res.status).toBe(200);
    expect(res.body.launchable.find((l: any) => l.file === 'TEST-SUITE.yml')).toMatchObject({ in_catalog: true });
    expect(res.body.e2e_projects.length).toBeGreaterThan(0);
  });

  it('lists recent launches from OASIS', async () => {
    events.push({ created_at: '2026-09-26T13:00:00Z', actor_email: 'admin@example.test', metadata: { repo: 'exafyltd/vitana-platform', workflow: 'TEST-SUITE.yml', label: 'Gateway', environment: 'dev_pr', reason: 'why' } });
    const res = await request(app).get('/api/v1/testing/launches');
    expect(res.body.launches).toEqual([{ at: '2026-09-26T13:00:00Z', by: 'admin@example.test', repo: 'exafyltd/vitana-platform', workflow: 'TEST-SUITE.yml', label: 'Gateway', environment: 'dev_pr', reason: 'why' }]);
  });
});
