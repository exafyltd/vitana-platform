/**
 * VTID-04637 — GET /api/v1/testing/catalog and the catalog loader.
 *
 * The catalog is read from the published object (a local directory here, via
 * CODE_INDEX_LOCAL_DIR, laid out exactly like the bucket). These tests pin:
 * admin-only access, a plain 503 when nothing is published, filtering by
 * environment/domain/runner, and the suite detail lookup.
 */
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

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
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => null }));
jest.mock('../../src/services/github-service', () => ({ __esModule: true, default: { triggerWorkflow: jest.fn(), getWorkflowRuns: jest.fn() } }));

import router from '../../src/routes/testing';
import { clearTestCatalogCache, loadTestCatalog, queryCatalog, suiteDetail, TEST_CATALOG_KEY, type TestCatalog } from '../../src/services/testing/test-catalog';

const CATALOG: TestCatalog = {
  schema_version: 1,
  generated_at: '2026-09-26T11:00:00Z',
  sources: { platform: { repo: 'exafyltd/vitana-platform', sha: 'abc', missing: false } },
  summary: { files: 3, cases: 7 },
  suites: [
    { id: 'platform:gateway:routes', name: 'Gateway — routes', repo: 'exafyltd/vitana-platform', kind: 'integration', runner: 'jest', files: 2, cases: 5, domain: 'oasis', domains: { oasis: 1, voice: 1 }, runs_in: ['TEST-SUITE.yml'], environments: ['dev_pr', 'nightly'], schedules: [{ workflow: 'TEST-SUITE.yml', cron: '17 3 * * *', human: 'daily 03:17 UTC' }], never_run: false, flags: [] },
    { id: 'platform:svc:vcaop-mcp', name: 'Service — vcaop-mcp', repo: 'exafyltd/vitana-platform', kind: 'unit', runner: 'jest', files: 1, cases: 2, domain: 'commerce', domains: { commerce: 1 }, runs_in: [], environments: [], schedules: [], never_run: true, flags: ['never_run'] },
  ],
  named_suites: [],
  workflows: [
    { id: 'platform:TEST-SUITE.yml', repo: 'exafyltd/vitana-platform', file: 'TEST-SUITE.yml', name: 'Test Suite', kind: 'test', triggers: {}, schedules: [], hosts: [], dead_hosts: [], runners: ['jest'], environments: ['dev_pr', 'nightly'], manual_trigger: true, flags: [] },
    { id: 'platform:ALERT-X.yml', repo: 'exafyltd/vitana-platform', file: 'ALERT-X.yml', name: 'Alert', kind: 'monitor', triggers: {}, schedules: [], hosts: [], dead_hosts: [], runners: ['db'], environments: ['production'], manual_trigger: false, flags: [] },
  ],
  other_workflows: [],
  files: [
    { repo: 'exafyltd/vitana-platform', path: 'services/gateway/test/routes/a.test.ts', suite_id: 'platform:gateway:routes', runner: 'jest', cases: 3, domain: 'oasis' },
    { repo: 'exafyltd/vitana-platform', path: 'services/gateway/test/routes/orb.test.ts', suite_id: 'platform:gateway:routes', runner: 'jest', cases: 2, domain: 'voice' },
    { repo: 'exafyltd/vitana-platform', path: 'services/vcaop-mcp/test/x.test.ts', suite_id: 'platform:svc:vcaop-mcp', runner: 'jest', cases: 2, domain: 'commerce' },
  ],
};

let dir: string;
const app = express();
app.use('/api/v1/testing', router);

function publish(catalog: unknown | null) {
  const file = path.join(dir, TEST_CATALOG_KEY);
  if (catalog === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(catalog))));
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-catalog-'));
  process.env.CODE_INDEX_LOCAL_DIR = dir;
});
afterAll(() => {
  delete process.env.CODE_INDEX_LOCAL_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mockIdentity = { user_id: 'admin-1', exafy_admin: true };
  clearTestCatalogCache();
  publish(CATALOG);
});

describe('GET /api/v1/testing/catalog', () => {
  it('answers 401 without a session and 403 for a non-admin', async () => {
    mockIdentity = null;
    expect((await request(app).get('/api/v1/testing/catalog')).status).toBe(401);
    mockIdentity = { user_id: 'member', exafy_admin: false };
    expect((await request(app).get('/api/v1/testing/catalog')).status).toBe(403);
  });

  it('returns the published catalog to an admin', async () => {
    const res = await request(app).get('/api/v1/testing/catalog');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, generated_at: '2026-09-26T11:00:00Z' });
    expect(res.body.suites).toHaveLength(2);
    expect(res.body.workflows).toHaveLength(2);
    expect(res.body.files).toBeUndefined();
  });

  it('filters by environment, including the never_run pseudo-environment', async () => {
    const prod = await request(app).get('/api/v1/testing/catalog?environment=production');
    expect(prod.body.suites).toHaveLength(0);
    expect(prod.body.workflows.map((w: any) => w.file)).toEqual(['ALERT-X.yml']);
    const never = await request(app).get('/api/v1/testing/catalog?environment=never_run');
    expect(never.body.suites.map((s: any) => s.id)).toEqual(['platform:svc:vcaop-mcp']);
  });

  it('answers 503 with a plain reason when nothing is published', async () => {
    publish(null);
    const res = await request(app).get('/api/v1/testing/catalog');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('catalog_unavailable');
    expect(res.body.message).toContain('TEST-CATALOG.yml');
  });
});

describe('GET /api/v1/testing/catalog/suite', () => {
  it('returns one suite with its files and workflows', async () => {
    const res = await request(app).get('/api/v1/testing/catalog/suite').query({ id: 'platform:gateway:routes' });
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.path)).toEqual([
      'services/gateway/test/routes/a.test.ts',
      'services/gateway/test/routes/orb.test.ts',
    ]);
    expect(res.body.workflows.map((w: any) => w.file)).toEqual(['TEST-SUITE.yml']);
  });

  it('answers 404 for an unknown suite and 400 without an id', async () => {
    expect((await request(app).get('/api/v1/testing/catalog/suite').query({ id: 'nope' })).status).toBe(404);
    expect((await request(app).get('/api/v1/testing/catalog/suite')).status).toBe(400);
  });
});

describe('loader + pure queries', () => {
  it('caches for the TTL and re-reads after it', async () => {
    let t = 0;
    const now = () => t;
    const first = await loadTestCatalog({ now, ttlMs: 1000 });
    expect(first.fromCache).toBe(false);
    publish({ ...CATALOG, generated_at: 'later' });
    t = 500;
    expect((await loadTestCatalog({ now, ttlMs: 1000 })).catalog.generated_at).toBe('2026-09-26T11:00:00Z');
    t = 2000;
    expect((await loadTestCatalog({ now, ttlMs: 1000 })).catalog.generated_at).toBe('later');
  });

  it('rejects a malformed catalog', async () => {
    publish({ nope: true });
    await expect(loadTestCatalog()).rejects.toThrow('malformed');
  });

  it('filters by domain across a suite\'s secondary domains', () => {
    expect(queryCatalog(CATALOG, { domain: 'voice' }).suites.map((s) => s.id)).toEqual(['platform:gateway:routes']);
    expect(queryCatalog(CATALOG, { domain: 'voice', include_files: true }).files).toHaveLength(2);
    expect(suiteDetail(CATALOG, 'missing')).toBeNull();
  });
});
