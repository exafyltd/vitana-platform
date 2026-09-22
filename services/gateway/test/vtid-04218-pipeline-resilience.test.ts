/**
 * VTID-04218: two pipeline gaps the 2026-09-21 Aurora write-freeze exposed.
 *
 * 1. The reconciler advanced 11 rows from `ci` to `deploying` after finding
 *    their PRs merged, but stamped no `merge_sha` — so the deploy stage could
 *    only match by recency and a later failure could not be auto-reverted.
 * 2. The watcher merged PRs on GitHub while every state write was refused by
 *    the database; `transitionStatus` reported the 0-row/refused PATCH as
 *    success and the merge went ahead unrecorded.
 */

import { mergedShaFromPr, reconcileStuckExecutions, type SupaConfig } from '../src/services/dev-autopilot-execute';
import { transitionMovedRow, transitionStatus } from '../src/services/dev-autopilot-watcher';
import * as fs from 'fs';
import * as path from 'path';

const ORIGINAL_FETCH = global.fetch;
const S: SupaConfig = { url: 'https://supabase.test', key: 'svc' } as SupaConfig;
const SHA = 'a89ad80c1f0b6e2c3d4e5f60718293a4b5c6d7e8';

afterEach(() => { global.fetch = ORIGINAL_FETCH; });

describe('VTID-04218: mergedShaFromPr', () => {
  it('returns the squash-merge SHA of a merged PR and null otherwise', () => {
    expect(mergedShaFromPr({ merged: true, merge_commit_sha: SHA })).toBe(SHA);
    expect(mergedShaFromPr({ merged: true, merge_commit_sha: `  ${SHA}\n` })).toBe(SHA);
    expect(mergedShaFromPr({ merged: false, merge_commit_sha: SHA })).toBeNull();
    expect(mergedShaFromPr({ merged: true, merge_commit_sha: null })).toBeNull();
    expect(mergedShaFromPr({ merged: true, merge_commit_sha: 'not-a-sha' })).toBeNull();
    expect(mergedShaFromPr(null)).toBeNull();
  });
});

describe('VTID-04218: transitionMovedRow', () => {
  it('is true only for a successful PATCH that returned at least one row', () => {
    expect(transitionMovedRow({ ok: true, data: [{ id: 'x' }] })).toBe(true);
    expect(transitionMovedRow({ ok: true, data: [] })).toBe(false);
    expect(transitionMovedRow({ ok: false, data: [{ id: 'x' }] })).toBe(false);
    expect(transitionMovedRow({ ok: true })).toBe(true); // no representation returned
  });
});

describe('VTID-04218: transitionStatus reports whether a row actually moved', () => {
  function mockPatch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: any }> = [];
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      calls.push({ url, init });
      if (String(url).includes('/rest/v1/oasis_events')) return { ok: true, status: 201, text: () => Promise.resolve(''), json: () => Promise.resolve([]) };
      return { ok: status < 400, status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)), json: () => Promise.resolve(body) };
    }) as unknown as typeof fetch;
    return calls;
  }

  it('asks for the representation and returns true when one row came back', async () => {
    const calls = mockPatch(200, [{ id: 'e1', status: 'merging' }]);
    await expect(transitionStatus(S, 'e1', 'ci', 'merging')).resolves.toBe(true);
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(patch?.url).toContain('dev_autopilot_executions?id=eq.e1&status=eq.ci');
    expect(patch?.init.headers.Prefer).toBe('return=representation');
  });

  it('returns false when the conditional PATCH matched no row (another tick moved it)', async () => {
    mockPatch(200, []);
    await expect(transitionStatus(S, 'e1', 'ci', 'merging')).resolves.toBe(false);
  });

  it('returns false when the database refuses the write (the write-freeze shape)', async () => {
    mockPatch(403, '{"code":"42501","message":"permission denied for table dev_autopilot_executions"}');
    await expect(transitionStatus(S, 'e1', 'ci', 'merging')).resolves.toBe(false);
  });
});

describe('VTID-04218: the live CI path merges only after ci→merging is recorded (source contract)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
  it('checks the transition result and `continue`s before calling mergePullRequest', () => {
    const guard = src.indexOf("const enteredMerging = await transitionStatus(s, exec.id, 'ci', 'merging');");
    const refuse = src.indexOf('if (!enteredMerging) {', guard);
    const merge = src.indexOf('githubService.mergePullRequest(', guard);
    expect(guard).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(guard);
    expect(merge).toBeGreaterThan(refuse);
    expect(src.slice(refuse, merge)).toMatch(/continue;/);
  });
});

describe('VTID-04218: reconcileStuckExecutions stamps merge_sha when it finds the PR merged', () => {
  function setup(opts: { status: 'ci' | 'merging'; merge_commit_sha: string | null }) {
    const patches: Array<{ url: string; body: any }> = [];
    const row = {
      id: 'exec-0001', finding_id: 'finding-1', status: opts.status, pr_url: 'https://github.com/exafyltd/vitana-platform/pull/3503', pr_number: 3503,
      branch: 'dev-autopilot/ff28fb31', updated_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      metadata: { executor: 'agent', llm_on_ramp: 'deepseek' },
    };
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      const u = String(url);
      const method = init?.method || 'GET';
      if (u.includes('/rest/v1/dev_autopilot_executions?status=eq.')) {
        return { ok: true, status: 200, json: () => Promise.resolve(u.includes(`status=eq.${opts.status}&`) ? [row] : []), text: () => Promise.resolve('[]') };
      }
      if (u.startsWith('https://api.github.com/repos/') && u.includes('/pulls/3503')) {
        return { ok: true, status: 200, json: () => Promise.resolve({ state: 'closed', merged: true, merge_commit_sha: opts.merge_commit_sha, mergeable_state: 'unknown', head: { sha: 'headsha' } }), text: () => Promise.resolve('') };
      }
      if (u.includes('/rest/v1/dev_autopilot_executions?id=eq.') && method === 'PATCH') {
        patches.push({ url: u, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: () => Promise.resolve([row]), text: () => Promise.resolve('[]') };
      }
      return { ok: true, status: 200, json: () => Promise.resolve([]), text: () => Promise.resolve('') };
    }) as unknown as typeof fetch;
    return patches;
  }

  beforeEach(() => { process.env.GITHUB_SAFE_MERGE_TOKEN = 'ghs_test'; });
  afterEach(() => { delete process.env.GITHUB_SAFE_MERGE_TOKEN; });

  it.each(['ci', 'merging'] as const)('from %s: advances to deploying with metadata.merge_sha merged into the existing metadata', async (status) => {
    const patches = setup({ status, merge_commit_sha: SHA });
    await reconcileStuckExecutions(S);
    const p = patches.find((x) => x.body.status === 'deploying');
    expect(p).toBeDefined();
    expect(p!.body.metadata).toEqual({ executor: 'agent', llm_on_ramp: 'deepseek', merge_sha: SHA });
  });

  it('still advances, without a merge_sha, when GitHub reports none', async () => {
    const patches = setup({ status: 'ci', merge_commit_sha: null });
    await reconcileStuckExecutions(S);
    const p = patches.find((x) => x.body.status === 'deploying');
    expect(p).toBeDefined();
    expect(p!.body.metadata).toBeUndefined();
  });
});
