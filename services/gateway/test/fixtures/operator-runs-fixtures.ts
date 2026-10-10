/**
 * VTID-05069: fixture sources for the Operator pipeline tree (run-view.ts) —
 * the three mock states of the plan (scratchpad mock desktop-s1/s2/s3), plus
 * a finished run. Shared by test/operator-runs-view.test.ts and the visual
 * harness (test/command-hub/fixtures/pipeline-tree-harness.*), never served.
 */
import type { RunViewDeps, CheckSummary, KiroLinkEvent, KiroRunSummary, VerifyEvent, WorkflowRunRow, PrDetail } from '../../src/services/operator-runs/run-view';
import type { GitHubPrSearchHit } from '../../src/services/github-service';

export const T0 = Date.parse('2026-10-10T20:35:00Z');
export const THREAD = 'thread-05071-spinner';
export const PLATFORM = 'exafyltd/vitana-platform';
export const V1 = 'exafyltd/vitana-v1';

const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

export interface FixtureState {
  vtid: string;
  title: string;
  ledgerTerminal?: boolean;
  sparring?: { rounds: number; verdict: string; approved_at: string | null } | null;
  kiroEvents?: KiroLinkEvent[];
  kiroRuns?: KiroRunSummary[];
  autopilot?: { id: string; status: string } | null;
  prs?: GitHubPrSearchHit[];
  prDetail?: Record<string, PrDetail>;
  prCommits?: Record<string, string[]>;
  checks?: Record<string, CheckSummary>;
  verify?: VerifyEvent[];
  workflowRuns?: Record<string, WorkflowRunRow[]>;
  production?: Record<string, string | null>;
  /** compare(repo, base, head) → status; key `${base}...${head}` */
  compare?: Record<string, string>;
  commitsBetween?: Record<string, Array<{ sha: string; message: string }>>;
  fail?: Partial<Record<keyof RunViewDeps, string>>;
}

export function checks(passed: number, failed: number, running: number, firstFailure?: { name: string; summary: string }): CheckSummary {
  return {
    total: passed + failed + running, passed, failed, running,
    first_failure: firstFailure ? { ...firstFailure, url: 'https://github.com/exafyltd/vitana-platform/actions/runs/1/job/2' } : null,
    url: null,
  };
}

export function pr(repo: string, number: number, title: string, state: 'open' | 'closed', merged: boolean): GitHubPrSearchHit {
  return { repo, number, title, state, merged, html_url: `https://github.com/${repo}/pull/${number}`, body: '', updated_at: iso(0) };
}

export function fixtureDeps(s: FixtureState, now: () => number = () => T0 + 6 * 60_000 + 12_000): RunViewDeps & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const hit = (k: keyof RunViewDeps): void => {
    calls[k] = (calls[k] || 0) + 1;
    const f = s.fail?.[k];
    if (f) throw new Error(f);
  };
  return {
    calls,
    async loadLedger(vtid) { hit('loadLedger'); return { vtid, title: s.title, status: s.ledgerTerminal ? 'completed' : 'in_progress', is_terminal: !!s.ledgerTerminal, created_at: iso(-4), metadata: {} }; },
    async loadSparring() { hit('loadSparring'); return s.sparring === undefined ? null : s.sparring ? { ...s.sparring, created_at: iso(-30) } : null; },
    async loadKiroEvents() { hit('loadKiroEvents'); return s.kiroEvents || []; },
    async loadKiroRuns() { hit('loadKiroRuns'); return s.kiroRuns || []; },
    async loadAutopilotExecution() { hit('loadAutopilotExecution'); return s.autopilot ? { ...s.autopilot, created_at: iso(0), updated_at: null } : null; },
    async searchPrs(vtids) { hit('searchPrs'); return (s.prs || []).filter((p) => vtids.some((v) => p.title.includes(v))); },
    async prDetail(repo, n) { hit('prDetail'); const d = s.prDetail?.[`${repo}#${n}`]; if (!d) throw new Error('no detail'); return d; },
    async prCommits(repo, n) { hit('prCommits'); return s.prCommits?.[`${repo}#${n}`] || []; },
    async checkSummary(repo, sha) { hit('checkSummary'); const c = s.checks?.[sha]; if (!c) throw new Error(`no checks for ${sha}`); return c; },
    async loadVerifyEvents() { hit('loadVerifyEvents'); return s.verify || []; },
    async workflowRuns(repo, wf) { hit('workflowRuns'); return s.workflowRuns?.[`${repo}:${wf}`] || []; },
    async productionCommit(service) { hit('productionCommit'); return s.production?.[service] ?? null; },
    async compare(repo, base, head) { hit('compare'); return s.compare?.[`${base}...${head}`] ?? 'behind'; },
    async commitsBetween(repo, base, head) { hit('commitsBetween'); return s.commitsBetween?.[`${repo}:${base}...${head}`] || []; },
    now: () => new Date(now()),
  };
}

const kiroRun = (status: string, toolCalls: number, title: string | null): KiroRunSummary => ({
  id: 'b5069000-0000-4000-8000-000000000001', thread_id: THREAD, status, created_at: iso(0), started_at: iso(0), ended_at: null, error: null,
  tool_calls: toolCalls, last_tool_title: title,
});

/** State 1 — work running in both repos (Kiro pushed to both, still editing). */
export const STATE_RUNNING: FixtureState = {
  vtid: 'VTID-05071',
  title: 'Operator activity spinner',
  sparring: { rounds: 2, verdict: 'converged', approved_at: iso(-4) },
  kiroEvents: [
    { topic: 'operator.kiro.branch_pushed', created_at: iso(3), thread_id: THREAD, repo: PLATFORM, branch: 'kiro/0adc6ff6/operator-spinner', commit_sha: '62383c1aaaa', files: 2 },
    { topic: 'operator.kiro.branch_pushed', created_at: iso(4), thread_id: THREAD, repo: V1, branch: 'kiro/0adc6ff6/operator-spinner', commit_sha: '7a1b2c3dddd', files: 1 },
  ],
  kiroRuns: [kiroRun('running', 14, 'Editing app.js — renderOperatorLiveTranscript()')],
};

/** State 2 — platform CI failed and Kiro is fixing it; vitana-v1 already merged. */
export const STATE_FIXING: FixtureState = {
  vtid: 'VTID-05072',
  title: 'Copy-paste images in Operator chat',
  sparring: { rounds: 3, verdict: 'converged', approved_at: iso(-97) },
  kiroEvents: [
    { topic: 'operator.kiro.branch_pushed', created_at: iso(-60), thread_id: THREAD, repo: PLATFORM, branch: 'kiro/0adc6ff6/paste-images', commit_sha: 'c1c1c1c', files: 5 },
  ],
  kiroRuns: [kiroRun('running', 6, 'Running jest test/vtid-04465-operator-pipeline-regression.test.ts')],
  prs: [
    pr(PLATFORM, 4127, 'VTID-05072: paste images in the Operator chat', 'open', false),
    pr(V1, 2210, 'VTID-05072: paste images (community app)', 'closed', true),
  ],
  prDetail: {
    [`${PLATFORM}#4127`]: { head_sha: 'c1c1c1c', head_ref: 'kiro/0adc6ff6/paste-images', draft: false, merged_at: null, merge_commit_sha: null, closed_at: null },
    [`${V1}#2210`]: { head_sha: 'v1head', head_ref: 'x', draft: false, merged_at: iso(-64), merge_commit_sha: 'a91c0e2ffff', closed_at: iso(-64) },
  },
  prCommits: { [`${PLATFORM}#4127`]: ['c1c1c1c'] },
  checks: {
    c1c1c1c: checks(11, 1, 0, { name: 'gateway-jest', summary: 'vtid-04465 operator pipeline › "kiro attachment is stored" — expected 201, got 400' }),
  },
  production: { gateway: 'prodgw1', 'community-app': 'prodfe1' },
  compare: { 'a91c0e2ffff...prodfe1': 'behind' },
};

/** State 3 — both merged, STAGING-VERIFY passed for both, production does not have it yet. */
export const STATE_GATE2: FixtureState = {
  vtid: 'VTID-05072',
  title: 'Copy-paste images in Operator chat',
  sparring: { rounds: 3, verdict: 'converged', approved_at: iso(-97) },
  kiroEvents: [
    { topic: 'operator.kiro.branch_pushed', created_at: iso(-60), thread_id: THREAD, repo: PLATFORM, branch: 'kiro/0adc6ff6/paste-images', commit_sha: 'c2c2c2c', files: 5 },
  ],
  kiroRuns: [{ ...kiroRun('completed', 31, null), ended_at: iso(-40) }],
  prs: [
    pr(PLATFORM, 4127, 'VTID-05072: paste images in the Operator chat', 'closed', true),
    pr(V1, 2210, 'VTID-05072: paste images (community app)', 'closed', true),
  ],
  prDetail: {
    [`${PLATFORM}#4127`]: { head_sha: 'c2c2c2c', head_ref: 'x', draft: false, merged_at: iso(-35), merge_commit_sha: '7f3e1d0eeee', closed_at: iso(-35) },
    [`${V1}#2210`]: { head_sha: 'v1head', head_ref: 'x', draft: false, merged_at: iso(-64), merge_commit_sha: 'a91c0e2ffff', closed_at: iso(-64) },
  },
  verify: [
    {
      topic: 'staging.verify.passed', created_at: iso(-15), service: 'gateway', commit: '7f3e1d0eeee', production_commit: 'prodgw1', run_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/900',
      vtids: ['VTID-05072', 'VTID-05070'], results: [{ suite: 'smoke', name: 'gateway', ok: true }, { suite: 'VTID-05072', name: 'paste', ok: true }],
    },
    {
      topic: 'staging.verify.passed', created_at: iso(-20), service: 'community-app', commit: 'a91c0e2ffff', production_commit: 'prodfe1', run_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/901',
      vtids: ['VTID-05072'], results: [{ suite: 'smoke', name: 'community-app', ok: true }],
    },
  ],
  production: { gateway: 'prodgw1', 'community-app': 'prodfe1' },
  compare: { '7f3e1d0eeee...prodgw1': 'behind', 'a91c0e2ffff...prodfe1': 'behind' },
  commitsBetween: {
    [`${PLATFORM}:prodgw1...7f3e1d0eeee`]: [
      { sha: '7f3e1d0eeee', message: 'VTID-05072: paste images in the Operator chat (#4127)' },
      { sha: '5e5e5e5aaaa', message: 'VTID-05070: ORB widget copy fix (#4125)' },
    ],
    [`${V1}:prodfe1...a91c0e2ffff`]: [
      { sha: 'a91c0e2ffff', message: 'VTID-05072: paste images (community app) (#2210)' },
    ],
  },
};

/** Finished: production contains both merges. */
export const STATE_DONE: FixtureState = {
  ...STATE_GATE2,
  compare: { '7f3e1d0eeee...prodgw2': 'ahead', 'a91c0e2ffff...prodfe2': 'identical' },
  production: { gateway: 'prodgw2', 'community-app': 'prodfe2' },
};
