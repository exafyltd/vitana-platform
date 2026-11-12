/**
 * VTID-05547 (plan agentic-delivery §3.13, tasks.md G1) — the cut guard on the two GitHub merge-side calls.
 *
 * With DELIVERY_HOST_<REPO>=gitlab for a repository, services/github-service.ts mergePullRequest and
 * updatePullRequestBranch make no GitHub call, write one OASIS event (delivery.merge.refused) and refuse with
 * merge_moved_to_gitlab. With the flag unset they behave exactly as before. safeMerge (routes/cicd.ts) and the
 * Project Manager's merge report the refusal as blocked, not as an error loop.
 *
 * Only the network is faked (the global fetch of setup-tests.ts) and the OASIS emitter (a mock that counts).
 * The merge-side calls under test are the real, guarded ones.
 */

jest.mock('../../src/services/oasis-event-service', () => {
  const mocks: Record<string, jest.Mock> = {};
  const cicdEvents = new Proxy({}, { get: (_t, name: string) => (mocks[name] ??= jest.fn(async () => ({ ok: true }))) });
  return { __esModule: true, emitOasisEvent: jest.fn(async () => ({ ok: true, event_id: 'evt-1' })), cicdEvents, default: cicdEvents, __mocks: mocks };
});
// The reads of safeMerge are stubbed; mergePullRequest and updatePullRequestBranch stay the real functions.
jest.mock('../../src/services/github-service', () => {
  const actual = jest.requireActual('../../src/services/github-service');
  const reads = {
    getPrStatus: jest.fn(),
    evaluateGovernance: jest.fn(),
    detectServiceFromFiles: jest.fn(() => null),
  };
  return { __esModule: true, ...actual, default: { ...actual.default, ...reads }, __reads: reads };
});

import {
  DELIVERY_VTID,
  MERGE_MOVED_TO_GITLAB,
  MergeMovedToGitlabError,
  assertGithubMergeAllowed,
  checkGithubMerge,
  deliveryHostEnvName,
  deliveryHostFor,
  isMergeMovedToGitlab,
  repoShortName,
} from '../../src/services/delivery-host';
import { mergePullRequest, updatePullRequestBranch } from '../../src/services/github-service';
import { safeMerge } from '../../src/routes/cicd';
import { actOnDecisions } from '../../src/services/project-manager/act';
import type { LeaseManager, LeaseOutcome } from '../../src/services/project-manager/lease';
import type { MergeDecision, ObservedLane, ObservedState } from '../../src/services/project-manager/types';

const oasis = jest.requireMock('../../src/services/oasis-event-service') as {
  emitOasisEvent: jest.Mock;
  cicdEvents: Record<string, jest.Mock>;
  __mocks: Record<string, jest.Mock>;
};
/** A cicdEvents helper's mock (created on first access, so a helper that was never called still has call data). */
const ev = (name: string): jest.Mock => oasis.cicdEvents[name];
const reads = (jest.requireMock('../../src/services/github-service') as { __reads: Record<string, jest.Mock> }).__reads;
const fetchMock = global.fetch as unknown as jest.Mock;

const PLATFORM = 'exafyltd/vitana-platform';
const V1 = 'exafyltd/vitana-v1';
const ENV0 = { ...process.env };

const githubCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('api.github.com'));
const refusals = () => oasis.emitOasisEvent.mock.calls.map(([e]) => e).filter((e) => e.type === 'delivery.merge.refused');

beforeEach(() => {
  process.env = { ...ENV0, GITHUB_SAFE_MERGE_TOKEN: 'fake-plat', FRONTEND_DEPLOY_TOKEN: 'fake-v1' };
  delete process.env.DELIVERY_HOST_VITANA_PLATFORM;
  delete process.env.DELIVERY_HOST_VITANA_V1;
  for (const f of Object.values(reads)) f.mockReset();
  reads.detectServiceFromFiles.mockReturnValue(null);
  for (const m of Object.values(oasis.__mocks)) m.mockClear();
  oasis.emitOasisEvent.mockReset();
  oasis.emitOasisEvent.mockResolvedValue({ ok: true, event_id: 'evt-1' });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/merge')) return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ sha: 'merged-sha', merged: true, message: 'Pull Request successfully merged' }) };
    if (String(url).endsWith('/update-branch')) return { ok: true, status: 202, statusText: 'Accepted', text: async () => '{"message":"Updating pull request branch."}' };
    return { ok: true, status: 200, statusText: 'OK', text: async () => '[]' };
  });
});
afterAll(() => {
  process.env = ENV0;
});

describe('VTID-05547 the flag — DELIVERY_HOST_<REPO>', () => {
  it('is named after the repository, upper-cased, other characters as "_"', () => {
    expect(deliveryHostEnvName(PLATFORM)).toBe('DELIVERY_HOST_VITANA_PLATFORM');
    expect(deliveryHostEnvName(V1)).toBe('DELIVERY_HOST_VITANA_V1');
    expect(deliveryHostEnvName('vitana/vitana-v1')).toBe('DELIVERY_HOST_VITANA_V1');
    expect(deliveryHostEnvName('exafyltd/Some.Repo-x')).toBe('DELIVERY_HOST_SOME_REPO_X');
    expect(repoShortName('vitana/vitana-platform')).toBe('vitana-platform');
    expect(repoShortName('')).toBeNull();
    expect(repoShortName(undefined)).toBeNull();
  });

  it('means GitLab only for the value "gitlab" (any case, trimmed); unset, empty and anything else mean GitHub', () => {
    const host = (v: string | undefined) => deliveryHostFor(PLATFORM, v === undefined ? {} : { DELIVERY_HOST_VITANA_PLATFORM: v });
    expect([host(undefined), host(''), host('github'), host('true'), host('1'), host('gitlab2')]).toEqual(['github', 'github', 'github', 'github', 'github', 'github']);
    expect([host('gitlab'), host('GitLab'), host('  gitlab  ')]).toEqual(['gitlab', 'gitlab', 'gitlab']);
  });

  it('is per repository: one flag does not move the other', () => {
    const env = { DELIVERY_HOST_VITANA_V1: 'gitlab' };
    expect(deliveryHostFor(V1, env)).toBe('gitlab');
    expect(deliveryHostFor(PLATFORM, env)).toBe('github');
  });

  it('checkGithubMerge is the same decision as plain data, with no event', () => {
    expect(checkGithubMerge(PLATFORM, 'merge', {})).toEqual({ allowed: true });
    expect(checkGithubMerge(PLATFORM, 'update_branch', { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab' })).toEqual({
      allowed: false,
      reason: 'merge_moved_to_gitlab',
      host: 'gitlab',
      repo: PLATFORM,
      operation: 'update_branch',
    });
    expect(oasis.emitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('VTID-05547 the guard — merge and update-branch with the flag set', () => {
  beforeEach(() => {
    process.env.DELIVERY_HOST_VITANA_PLATFORM = 'gitlab';
  });

  it('mergePullRequest makes no GitHub call, refuses with merge_moved_to_gitlab and emits one OASIS event', async () => {
    const err = await mergePullRequest(PLATFORM, 7, 'VTID-05547 (agentic-delivery/gateway-delivery): x (#7)', 'squash').catch((e) => e);
    expect(isMergeMovedToGitlab(err)).toBe(true);
    expect(err).toBeInstanceOf(MergeMovedToGitlabError);
    expect(err.code).toBe(MERGE_MOVED_TO_GITLAB);
    expect(err.message.startsWith('merge_moved_to_gitlab: exafyltd/vitana-platform delivers on GitLab')).toBe(true);
    expect(err.message).toContain('PR #7');
    expect(githubCalls()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({
      vtid: 'VTID-05547',
      type: 'delivery.merge.refused',
      source: 'gateway-delivery-guard',
      status: 'warning',
      task_stage: 'VALIDATOR',
      payload: { plane: 'delivery', host: 'gitlab', mode: 'live', repo: 'vitana-platform', github_repo: PLATFORM, pr_number: 7, operation: 'merge', reason: 'merge_moved_to_gitlab', dedupe_key: `github:${PLATFORM}:pull:7:refused_merge` },
    });
  });

  it('updatePullRequestBranch makes no GitHub call, refuses and emits one OASIS event', async () => {
    const err = await updatePullRequestBranch(PLATFORM, 9, 'headsha').catch((e) => e);
    expect(isMergeMovedToGitlab(err)).toBe(true);
    expect(err.operation).toBe('update_branch');
    expect(err.message).toContain('update-branch');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({ vtid: DELIVERY_VTID, payload: { operation: 'update_branch', pr_number: 9, dedupe_key: `github:${PLATFORM}:pull:9:refused_update_branch` } });
  });

  it('a commit title without a VTID gives the BOOTSTRAP-DELIVERY VTID; the first VTID of a title with several is used', async () => {
    await mergePullRequest(PLATFORM, 1, 'no ticket', 'squash').catch(() => undefined);
    await mergePullRequest(PLATFORM, 2, 'Fix VTID-01234 and VTID-05678', 'squash').catch(() => undefined);
    expect(refusals().map((e) => e.vtid)).toEqual(['BOOTSTRAP-DELIVERY', 'VTID-01234']);
  });

  it('the other repository is not affected by this repository\'s flag', async () => {
    const r = await mergePullRequest(V1, 3, 'VTID-05547: y', 'squash', 'fake-v1');
    expect(r).toEqual({ sha: 'merged-sha', merged: true, message: 'Pull Request successfully merged' });
    expect(githubCalls().map(([url]) => String(url))).toEqual([`https://api.github.com/repos/${V1}/pulls/3/merge`]);
    expect(refusals()).toHaveLength(0);
  });

  it('a failing OASIS write never stops the refusal', async () => {
    oasis.emitOasisEvent.mockRejectedValue(new Error('oasis down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = await mergePullRequest(PLATFORM, 7, 'VTID-05547: x', 'squash').catch((e) => e);
    spy.mockRestore();
    expect(isMergeMovedToGitlab(err)).toBe(true);
    expect(githubCalls()).toHaveLength(0);
  });

  it('assertGithubMergeAllowed takes the environment and the emitter as dependencies', async () => {
    const emit = jest.fn(async () => ({ ok: true }));
    await expect(assertGithubMergeAllowed(V1, 'merge', { prNumber: 5, commitTitle: 'VTID-00042 z' }, { env: { DELIVERY_HOST_VITANA_V1: 'gitlab' }, emit })).rejects.toMatchObject({ code: 'merge_moved_to_gitlab', repo: V1, prNumber: 5 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ vtid: 'VTID-00042', payload: { repo: 'vitana-v1' } });
    await expect(assertGithubMergeAllowed(V1, 'merge', {}, { env: {}, emit })).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('VTID-05547 the guard — flag unset: exactly as before', () => {
  it('mergePullRequest calls GitHub with the same URL, method, body and token, and returns its answer', async () => {
    const r = await mergePullRequest(PLATFORM, 7, 'VTID-05547: x (#7)', 'squash');
    expect(r).toEqual({ sha: 'merged-sha', merged: true, message: 'Pull Request successfully merged' });
    expect(githubCalls()).toHaveLength(1);
    const [url, init] = githubCalls()[0];
    expect(String(url)).toBe(`https://api.github.com/repos/${PLATFORM}/pulls/7/merge`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ commit_title: 'VTID-05547: x (#7)', merge_method: 'squash' });
    expect(init.headers.Authorization).toBe('Bearer fake-plat');
    expect(refusals()).toHaveLength(0);
    expect(oasis.emitOasisEvent).not.toHaveBeenCalled();
  });

  it('updatePullRequestBranch calls GitHub with the same URL, method and body', async () => {
    await updatePullRequestBranch(PLATFORM, 9, 'headsha');
    const [url, init] = githubCalls()[0];
    expect(String(url)).toBe(`https://api.github.com/repos/${PLATFORM}/pulls/9/update-branch`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ expected_head_sha: 'headsha' });
    expect(oasis.emitOasisEvent).not.toHaveBeenCalled();
  });

  it('a flag set to github, empty or something else changes nothing', async () => {
    for (const v of ['github', '', 'off', 'gitlab-later']) {
      process.env.DELIVERY_HOST_VITANA_PLATFORM = v;
      fetchMock.mockClear();
      await mergePullRequest(PLATFORM, 7, 'VTID-05547: x', 'squash');
      expect(githubCalls()).toHaveLength(1);
    }
    expect(refusals()).toHaveLength(0);
  });

  it('a GitHub error still reaches the caller unchanged (the guard does not catch it)', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 405, statusText: 'Method Not Allowed', text: async () => '{"message":"Pull Request is not mergeable"}' }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = await mergePullRequest(PLATFORM, 7, 'VTID-05547: x', 'squash').catch((e) => e);
    spy.mockRestore();
    expect(isMergeMovedToGitlab(err)).toBe(false);
    expect(err.message).toBe('GitHub API error: 405 - Method Not Allowed: Pull Request is not mergeable');
  });
});

describe('VTID-05547 safeMerge and the Project Manager report the refusal as blocked, not as an error loop', () => {
  const REQ = { vtid: 'VTID-05547', repo: PLATFORM, pr_number: 4242, require_checks: true, merge_strategy: 'squash' as const };
  const open = () => ({ pr: { state: 'open', base: { ref: 'main' }, head: { ref: 'kiro/x/y' }, title: 'VTID-05547 x' }, checks: [], allPassed: true });
  const approved = () => ({ decision: 'approved', files_touched: [], services_impacted: [], blocked_reasons: [] });

  it('safeMerge with the flag set: refused, one safe_merge.blocked event, no executed event, no GitHub merge call', async () => {
    process.env.DELIVERY_HOST_VITANA_PLATFORM = 'gitlab';
    reads.getPrStatus.mockResolvedValue(open());
    reads.evaluateGovernance.mockResolvedValue(approved());
    const out = await safeMerge(REQ);
    expect(out.result).toBe('refused');
    expect(out.body.ok).toBe(false);
    expect((out.body as { details?: { error?: string } }).details?.error).toContain('merge_moved_to_gitlab');
    expect(githubCalls()).toHaveLength(0);
    expect(ev('safeMergeBlocked')).toHaveBeenCalledTimes(1);
    expect(ev('safeMergeBlocked').mock.calls[0].slice(0, 2)).toEqual(['VTID-05547', 4242]);
    expect(String(ev('safeMergeBlocked').mock.calls[0][3]?.error)).toContain('merge_moved_to_gitlab');
    expect(ev('safeMergeExecuted')).not.toHaveBeenCalled();
    expect(refusals()).toHaveLength(1);
  });

  it('safeMerge with the flag unset merges and records the merge as before', async () => {
    reads.getPrStatus.mockResolvedValue(open());
    reads.evaluateGovernance.mockResolvedValue(approved());
    const out = await safeMerge(REQ);
    expect(out.result).toBe('merged');
    expect(out.status).toBe(200);
    expect(githubCalls().map(([url]) => String(url))).toEqual([`https://api.github.com/repos/${PLATFORM}/pulls/4242/merge`]);
    expect(ev('safeMergeExecuted')).toHaveBeenCalledWith('VTID-05547', 4242, 'merged-sha');
    expect(ev('safeMergeBlocked')).not.toHaveBeenCalled();
    expect(refusals()).toHaveLength(0);
  });

  // ---- the Project Manager, driving the real safeMerge ----------------------------------------------------
  class AcquiredLease implements LeaseManager {
    async acquire(holder: string): Promise<LeaseOutcome> {
      return { acquired: true, holder, expires_at: '2026-11-05T12:09:00Z' };
    }
  }
  const lane = (): ObservedLane => ({
    slug: 'agentic-delivery', lane: 'gateway-delivery', vtid: 'VTID-05547', state: 'verified', seat: 'exafy', reviewer_seat: 'agent:vitana-lane-reviewer', area: 'platform',
    paths: ['services/gateway/src/services/delivery-host.ts'], depends_on: [],
    pr: { url: `https://github.com/${PLATFORM}/pull/4242`, title: 'VTID-05547 x', head_sha: 'headsha', checks: [], mergeable: true, merged: false, consecutive_ci_failures: 0 },
    reviews: [], executing_log: [], state_since: '2026-11-05T00:00:00Z', last_branch_activity: null, claimed_at: null, seat_ran_automation_in_window: true,
    staging_verified: false, deploys: false, staging_verified_at: null, gate2_sent: false,
  } as ObservedLane);

  async function pmMerge() {
    process.env.PM_MODE = 'live';
    const l = lane();
    const state: ObservedState = { mode: 'live', lanes: [l], rotations: [] };
    const decision: MergeDecision = { kind: 'merge', slug: l.slug, lane: l.lane, vtid: 'VTID-05547', pr_url: l.pr!.url, head_sha: 'headsha' };
    const laneChanges: unknown[] = [];
    const res = await actOnDecisions([decision], state, {
      safeMerge,
      laneWriter: { write: async (c) => { laneChanges.push(c); return 'written'; } },
      gate2Poster: { post: async () => undefined },
      gate2Evidence: { resolve: async () => ({ verified_commit: 'v', production_commit: 'p', commits: [] }) },
      lease: new AcquiredLease(),
    });
    return { res, laneChanges };
  }

  it('the Project Manager with the flag set: merge_refused, the lane is not set done, nothing is thrown', async () => {
    process.env.DELIVERY_HOST_VITANA_PLATFORM = 'gitlab';
    reads.getPrStatus.mockResolvedValue(open());
    reads.evaluateGovernance.mockResolvedValue(approved());
    const { res, laneChanges } = await pmMerge();
    expect(res.acted).toBe(true);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].status).toBe('merge_refused');
    expect(res.results[0].status).not.toBe('act_error');
    expect(laneChanges).toHaveLength(0);
    expect(githubCalls()).toHaveLength(0);
  });

  it('the Project Manager with the flag unset still merges and sets the lane done', async () => {
    reads.getPrStatus.mockResolvedValue(open());
    reads.evaluateGovernance.mockResolvedValue(approved());
    const { res, laneChanges } = await pmMerge();
    expect(res.results[0].status).toBe('merged');
    expect(laneChanges).toHaveLength(1);
    expect(laneChanges[0]).toMatchObject({ state: 'done' });
  });
});
