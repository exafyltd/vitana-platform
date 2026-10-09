/**
 * VTID-05014: Kiro (and the Operator's PR tools) write to exafyltd/vitana-v1 as
 * well as vitana-platform, with the same gates and one token resolver.
 *
 * Pins: the per-repo push deny lists; every vitana-v1 call uses the vitana-v1
 * token and never the platform token; a missing vitana-v1 token fails loudly
 * before any GitHub call; the PR executors forward `repo`; /create-pr and
 * /safe-merge accept both repos, refuse a third, and pass the right token;
 * the merge target check reads the PR from the right repo; the readiness probe
 * is read-only and admin-only.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

jest.mock('node-fetch');
jest.mock('../src/services/oasis-event-service', () => {
  const ev = new Proxy({}, { get: () => jest.fn(async () => ({ ok: true })) });
  return { __esModule: true, default: ev, emitOasisEvent: jest.fn(async () => ({ ok: true })), recommendationSyncEvents: {} };
});

const gh = {
  getPullRequest: jest.fn(),
  getPrStatus: jest.fn(),
  evaluateGovernance: jest.fn(),
  mergePullRequest: jest.fn(),
  createPullRequest: jest.fn(),
  detectServiceFromFiles: jest.fn(() => null),
};
jest.mock('../src/services/github-service', () => {
  const actual = jest.requireActual('../src/services/github-service');
  const mod = { ...actual, ...gh };
  return { __esModule: true, ...mod, getPullRequest: (...a: unknown[]) => gh.getPullRequest(...a), default: { ...actual.default, ...gh, repoGitHubToken: actual.repoGitHubToken } };
});

import fetch from 'node-fetch';
import { validatePush, pushKiroBranch, pushToken } from '../src/services/kiro/kiro-push-branch';
import { checkTargetVtid, summarizeWrite } from '../src/services/kiro/kiro-mcp-writes';
import { kiroRepoReadiness } from '../src/services/kiro/kiro-repo-readiness';
import { repoGitHubToken, VITANA_REPOS } from '../src/services/github-service';
import { executeTool } from '../src/services/gemini-operator';
import cicdRouter from '../src/routes/cicd';

const U = '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
const V1 = 'exafyltd/vitana-v1';
const PLATFORM = 'exafyltd/vitana-platform';
const branch = 'kiro/0adc6ff6/fix-card';
const push = (repo: string, p: string) => ({ repo, branch, message: 'VTID-05014: x', files: [{ path: p, content: 'x' }] });
const ENV0 = { ...process.env };

beforeEach(() => {
  process.env = { ...ENV0, GITHUB_SAFE_MERGE_TOKEN: 'platform-token', FRONTEND_DEPLOY_TOKEN: 'v1-token' };
  for (const f of Object.values(gh)) (f as jest.Mock).mockReset();
  gh.detectServiceFromFiles.mockReturnValue(null);
});
afterAll(() => { process.env = ENV0; });

describe('one allowlist, one token resolver', () => {
  it('both repos; platform → default token, vitana-v1 → FRONTEND_DEPLOY_TOKEN; unset → loud, never the platform token', () => {
    expect([...VITANA_REPOS]).toEqual([PLATFORM, V1]);
    expect(repoGitHubToken(PLATFORM)).toBeUndefined();
    expect(repoGitHubToken(V1)).toBe('v1-token');
    expect(pushToken(PLATFORM)).toBe('platform-token');
    expect(pushToken(V1)).toBe('v1-token');
    delete process.env.FRONTEND_DEPLOY_TOKEN;
    expect(() => repoGitHubToken(V1)).toThrow(/repo_token_not_configured/);
    expect(() => pushToken(V1)).toThrow(/repo_token_not_configured/);
    expect(() => pushToken('someone/else')).toThrow(/not allowed/);
  });
});

describe('push deny lists, per repo', () => {
  it('vitana-v1: supabase/ (all of it), AGENTS.md, .env files, eslint rules/config refused; app code allowed', () => {
    for (const p of ['supabase/functions/x/index.ts', 'supabase/migrations/2026_x.sql', 'supabase/config.toml', 'supabase/seed.sql',
      'AGENTS.md', '.env', '.env.local', 'src/.env.production', 'eslint-rules/no-raw.js', 'eslint.config.js', 'eslint-patterns.config.js',
      '.github/workflows/DEPLOY.yml', '.claude/rules/x.md', 'CLAUDE.md', 'package.json', 'docs/validation/VTID-1/x.md']) {
      expect([p, validatePush(push(V1, p), U).ok]).toEqual([p, false]);
    }
    for (const p of ['src/pages/Home.tsx', 'src/i18n/de/home.json', 'docs/notes.md', 'src/environment.ts']) {
      expect([p, validatePush(push(V1, p), U).ok]).toEqual([p, true]);
    }
  });

  it('vitana-platform: unchanged (gov/, scripts/ci/, supabase/migrations/ refused; supabase/functions not a v1-only rule here)', () => {
    for (const p of ['gov/x.md', 'scripts/ci/guard.js', 'supabase/migrations/x.sql', '.github/x.yml', 'CLAUDE.md']) {
      expect([p, validatePush(push(PLATFORM, p), U).ok]).toEqual([p, false]);
    }
    for (const p of ['services/gateway/src/x.ts', 'AGENTS.md', 'eslint.config.js']) {
      expect([p, validatePush(push(PLATFORM, p), U).ok]).toEqual([p, true]);
    }
  });
});

describe('pushKiroBranch on vitana-v1', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('every GitHub call carries the vitana-v1 token, never the platform token', async () => {
    const auths: string[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      auths.push(String(init.headers.Authorization));
      const u = String(url);
      const json = (o: unknown, status = 200) => ({ ok: status < 300, status, text: async () => (o === null ? '' : JSON.stringify(o)) });
      if (init.method === 'GET' && u.endsWith(`/heads/${branch}`)) return json({ message: 'Not Found' }, 404);
      if (init.method === 'GET' && u.endsWith('/heads/main')) return json({ object: { sha: 'main-sha' } });
      if (u.includes('/git/commits/')) return json({ tree: { sha: 'base' } });
      if (u.endsWith('/git/blobs')) return json({ sha: 'b1' });
      if (u.endsWith('/git/trees')) return json({ sha: 't1' });
      if (u.endsWith('/git/commits')) return json({ sha: 'c1' });
      return json({});
    }) as any;
    const r = await pushKiroBranch(push(V1, 'src/pages/Home.tsx'), U);
    expect(r).toMatchObject({ ok: true, commit_sha: 'c1', created: true });
    expect(auths.length).toBeGreaterThan(3);
    expect(new Set(auths)).toEqual(new Set(['Bearer v1-token']));
    expect((global.fetch as jest.Mock).mock.calls.every((c) => String(c[0]).includes(`/repos/${V1}/`))).toBe(true);
  });

  it('a missing vitana-v1 token fails before any GitHub call', async () => {
    delete process.env.FRONTEND_DEPLOY_TOKEN;
    global.fetch = jest.fn() as any;
    const r = await pushKiroBranch(push(V1, 'src/pages/Home.tsx'), U);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/repo_token_not_configured/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the PR executors forward repo', () => {
  const fetchMock = fetch as unknown as jest.Mock;
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, pr_number: 9, pr_url: 'u' }) });
  });
  const body = () => JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);

  it('dev_create_pr / dev_merge_pr send the chosen repo, default vitana-platform', async () => {
    await executeTool('dev_create_pr', { vtid: 'VTID-05014', repo: V1, head_branch: branch }, 't');
    expect(body()).toMatchObject({ repo: V1, head: branch, base: 'main' });
    await executeTool('dev_create_pr', { vtid: 'VTID-05014', head_branch: branch }, 't');
    expect(body().repo).toBe(PLATFORM);
    await executeTool('dev_merge_pr', { vtid: 'VTID-05014', repo: V1, pr_number: 9 }, 't');
    expect(body()).toMatchObject({ repo: V1, pr_number: 9, merge_strategy: 'squash' });
    await executeTool('dev_merge_pr', { vtid: 'VTID-05014', pr_number: 9 }, 't');
    expect(body().repo).toBe(PLATFORM);
  });
});

describe('/create-pr and /safe-merge', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/github', cicdRouter);

  it('/create-pr opens on vitana-v1 with the v1 token; platform call unchanged; a third repo is refused', async () => {
    gh.createPullRequest.mockResolvedValue({ number: 5, html_url: 'https://x/5' });
    const base = { vtid: 'VTID-05014', title: 'VTID-05014: x', body: 'b', head: branch };
    const r1 = await request(app).post('/api/v1/github/create-pr').send({ ...base, repo: V1 });
    expect(r1.status).toBe(201);
    expect(gh.createPullRequest).toHaveBeenLastCalledWith(V1, base.title, 'b', branch, 'main', 'v1-token');
    const r2 = await request(app).post('/api/v1/github/create-pr').send(base);
    expect(r2.status).toBe(201);
    expect(gh.createPullRequest).toHaveBeenLastCalledWith(PLATFORM, base.title, 'b', branch, 'main');
    const r3 = await request(app).post('/api/v1/github/create-pr').send({ ...base, repo: 'someone/else' });
    expect(r3.status).toBe(403);
    expect(gh.createPullRequest).toHaveBeenCalledTimes(2);
  });

  it('/safe-merge merges a green, approved vitana-v1 PR with the v1 token at every step; refuses a third repo', async () => {
    gh.getPrStatus.mockResolvedValue({ pr: { state: 'open', base: { ref: 'main' }, head: { ref: branch }, title: 'VTID-05014: x', mergeable: true }, checks: [], allPassed: true });
    gh.evaluateGovernance.mockResolvedValue({ decision: 'approved', files_touched: ['src/pages/Home.tsx'], services_impacted: [], blocked_reasons: [] });
    gh.mergePullRequest.mockResolvedValue({ sha: 'm1', merged: true, message: 'ok' });
    const r = await request(app).post('/api/v1/github/safe-merge').send({ vtid: 'VTID-05014', repo: V1, pr_number: 5, merge_strategy: 'squash' });
    expect(r.status).toBe(200);
    expect(gh.getPrStatus).toHaveBeenCalledWith(V1, 5, 'v1-token');
    expect(gh.evaluateGovernance).toHaveBeenCalledWith(V1, 5, 'VTID-05014', 'v1-token');
    expect(gh.mergePullRequest).toHaveBeenCalledWith(V1, 5, expect.any(String), 'squash', 'v1-token');
    const bad = await request(app).post('/api/v1/github/safe-merge').send({ vtid: 'VTID-05014', repo: 'someone/else', pr_number: 5 });
    expect(bad.status).toBe(403);
    expect(bad.body.reason).toBe('unauthorized_repo');
  });

  it('/safe-merge still refuses a vitana-v1 PR that governance blocks (workflow change)', async () => {
    gh.getPrStatus.mockResolvedValue({ pr: { state: 'open', base: { ref: 'main' }, head: { ref: branch }, title: 'VTID-05014: x', mergeable: true }, checks: [], allPassed: true });
    gh.evaluateGovernance.mockResolvedValue({ decision: 'blocked', files_touched: ['.github/workflows/DEPLOY.yml'], services_impacted: [], blocked_reasons: ['Sensitive path'] });
    const r = await request(app).post('/api/v1/github/safe-merge').send({ vtid: 'VTID-05014', repo: V1, pr_number: 5 });
    expect(r.status).toBe(403);
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('merge target check and the Allow card', () => {
  it('reads the PR from the merge repo with its token; refuses a third repo', async () => {
    gh.getPullRequest.mockResolvedValue({ title: 'VTID-05014: x' });
    expect(await checkTargetVtid('dev_merge_pr', { repo: V1, pr_number: 5 }, 'VTID-05014')).toEqual({ ok: true });
    expect(gh.getPullRequest).toHaveBeenLastCalledWith(V1, 5, 'v1-token');
    expect(await checkTargetVtid('dev_merge_pr', { pr_number: 5 }, 'VTID-05014')).toEqual({ ok: true });
    expect(gh.getPullRequest).toHaveBeenLastCalledWith(PLATFORM, 5);
    expect((await checkTargetVtid('dev_merge_pr', { repo: 'someone/else', pr_number: 5 }, 'VTID-05014')).ok).toBe(false);
    delete process.env.FRONTEND_DEPLOY_TOKEN;
    const r = await checkTargetVtid('dev_merge_pr', { repo: V1, pr_number: 5 }, 'VTID-05014');
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/repo_token_not_configured/) });
  });

  it('PR cards always name the repo', () => {
    expect(summarizeWrite('dev_merge_pr', { pr_number: 5 })).toContain(`repo=${PLATFORM}`);
    expect(summarizeWrite('dev_create_pr', { repo: V1, head_branch: branch })).toContain(`repo=${V1}`);
    expect(summarizeWrite('dev_push_kiro_branch', push(V1, 'src/a.ts'))).toContain(`${V1}:${branch}`);
  });
});

describe('readiness probe', () => {
  it('one GET per repo with that repo\'s token; reports permissions, never the token', async () => {
    const f = jest.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ permissions: { admin: false, push: url.includes('v1'), pull: true } }) }));
    const r = await kiroRepoReadiness(f as any);
    expect(f.mock.calls.map((c: any) => [c[0], c[1].headers.Authorization, c[1].method ?? 'GET'])).toEqual([
      [`https://api.github.com/repos/${PLATFORM}`, 'Bearer platform-token', 'GET'],
      [`https://api.github.com/repos/${V1}`, 'Bearer v1-token', 'GET'],
    ]);
    expect(r.map((x) => [x.repo, x.token_configured, x.can_read, x.permissions?.push])).toEqual([[PLATFORM, true, true, false], [V1, true, true, true]]);
    expect(JSON.stringify(r)).not.toMatch(/platform-token|v1-token/);
    delete process.env.FRONTEND_DEPLOY_TOKEN;
    const r2 = await kiroRepoReadiness(f as any);
    expect(r2[1]).toMatchObject({ repo: V1, token_configured: false, can_read: false });
  });

  it('the route is admin-only (source check)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/operator.ts'), 'utf8');
    expect(src).toMatch(/router\.get\('\/kiro\/repos', requireAdminAuth/);
  });
});
