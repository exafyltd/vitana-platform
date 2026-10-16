/**
 * VTID-05217 — the in-process `safeMerge` function extracted from routes/cicd.ts
 * (plan §6.3 item 1). Two things are proven here:
 *   1. the extraction is BEHAVIOUR-PRESERVING — the function returns the same
 *      status + body the route used to return for each gate outcome;
 *   2. a PR that is not open (`pr_not_open`) maps to the typed `already_merged`
 *      no-op result for in-process callers, while NO merge API call is made.
 *
 * github-service and the OASIS event emitter are mocked so no network happens.
 * The merge API (`mergePullRequest`) is a jest.fn whose call count is asserted —
 * it must NOT be called for the already-merged / refused cases, and exactly
 * once for a clean merge.
 */

jest.mock('../../src/services/github-service', () => ({
  __esModule: true,
  default: {
    getPrStatus: jest.fn(),
    evaluateGovernance: jest.fn(),
    mergePullRequest: jest.fn(),
    detectServiceFromFiles: jest.fn(() => null),
  },
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    { get: () => async () => ({ ok: true }) },
  ),
}));

import githubService from '../../src/services/github-service';
import { safeMerge } from '../../src/routes/cicd';

const gh = githubService as unknown as {
  getPrStatus: jest.Mock;
  evaluateGovernance: jest.Mock;
  mergePullRequest: jest.Mock;
  detectServiceFromFiles: jest.Mock;
};

function openPr(headRef = 'kiro/pm-agent/p4-act') {
  return {
    pr: { state: 'open', base: { ref: 'main' }, head: { ref: headRef }, title: 'VTID-05217 act' },
    checks: [{ name: 'PR-GATE', status: 'success' }],
    allPassed: true,
  };
}

const REQ = { vtid: 'VTID-05217', repo: 'exafyltd/vitana-platform', pr_number: 4242, require_checks: true, merge_strategy: 'squash' as const };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('safeMerge — clean merge', () => {
  it('merges exactly once and returns result "merged" with status 200', async () => {
    gh.getPrStatus.mockResolvedValue(openPr());
    gh.evaluateGovernance.mockResolvedValue({ decision: 'approved', files_touched: ['services/gateway/x.ts'], services_impacted: ['gateway'], blocked_reasons: [] });
    gh.mergePullRequest.mockResolvedValue({ sha: 'mergedsha', merged: true, message: 'ok' });

    const out = await safeMerge(REQ);

    expect(out.result).toBe('merged');
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.merged).toBe(true);
    expect(gh.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});

describe('safeMerge — pr not open → already_merged no-op', () => {
  it('returns result "already_merged", keeps the identical 400 pr_not_open body, and NEVER merges', async () => {
    gh.getPrStatus.mockResolvedValue({ pr: { state: 'closed', base: { ref: 'main' }, head: { ref: 'x' }, title: 't' }, checks: [], allPassed: true });

    const out = await safeMerge(REQ);

    expect(out.result).toBe('already_merged');
    // route-behaviour-preserving: same status + body the route returned before.
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ ok: false, reason: 'pr_not_open', vtid: 'VTID-05217', details: { pr_state: 'closed' } });
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('safeMerge — refused outcomes (behaviour-preserving)', () => {
  it('unauthorized repo → refused 403, no merge', async () => {
    const out = await safeMerge({ ...REQ, repo: 'exafyltd/not-allowed' });
    expect(out.result).toBe('refused');
    expect(out.status).toBe(403);
    expect(out.body.reason).toBe('unauthorized_repo');
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('pr not found → refused 404, no merge', async () => {
    gh.getPrStatus.mockRejectedValue(new Error('404 not found'));
    const out = await safeMerge(REQ);
    expect(out.result).toBe('refused');
    expect(out.status).toBe(404);
    expect(out.body.reason).toBe('pr_not_found');
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('invalid base → refused 400, no merge', async () => {
    gh.getPrStatus.mockResolvedValue({ pr: { state: 'open', base: { ref: 'develop' }, head: { ref: 'x' }, title: 't' }, checks: [], allPassed: true });
    const out = await safeMerge(REQ);
    expect(out.result).toBe('refused');
    expect(out.status).toBe(400);
    expect(out.body.reason).toBe('invalid_base');
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('checks failed → refused 400, no merge', async () => {
    gh.getPrStatus.mockResolvedValue({ pr: { state: 'open', base: { ref: 'main' }, head: { ref: 'x' }, title: 't' }, checks: [{ name: 'c', status: 'failure' }], allPassed: false });
    const out = await safeMerge(REQ);
    expect(out.result).toBe('refused');
    expect(out.status).toBe(400);
    expect(out.body.reason).toBe('checks_failed');
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it('governance blocked → refused 403, no merge', async () => {
    gh.getPrStatus.mockResolvedValue(openPr());
    gh.evaluateGovernance.mockResolvedValue({ decision: 'blocked', files_touched: ['x'], services_impacted: [], blocked_reasons: ['nope'] });
    const out = await safeMerge(REQ);
    expect(out.result).toBe('refused');
    expect(out.status).toBe(403);
    expect(out.body.reason).toBe('governance_blocked');
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });
});
