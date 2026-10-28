/**
 * VTID-04017 (W3): CI feedback loop in fix mode.
 *
 * When CI fails on a PR the agent executor opened, the retry child no longer
 * starts over on a fresh branch: the PR stays open, the child carries
 * `metadata.fix_mode` (branch / PR / parent), the runner clones that branch,
 * gets the CI log evidence as its task, pushes a fast-forward onto the same
 * branch, and returns the same PR so the watcher keeps tracking it. Per-run
 * agent usage/cost is appended to the finding's outcome row.
 */

import {
  isFixModeEligible, buildFixModeInfo, parseFixMode, spawnChildExecution, bridgeFailureToSelfHealing,
} from '../src/services/dev-autopilot-bridge';
import { priorPrBlocksExecution } from '../src/services/dev-autopilot-execute';
import { buildFixModeTaskPrompt } from '../src/services/autopilot-agent/agent-prompt';
import { commitAndPush, fetchRefSha, listChangedFilesSince, parseNameStatus, prepareWorkspace, type ExecFn } from '../src/services/autopilot-agent/agent-workspace';
import { appendAgentRun, recordAgentRunUsage, type AgentRunUsage } from '../src/services/dev-autopilot-outcomes';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt' }),
}));
jest.mock('../src/services/self-healing-triage-service', () => ({ spawnTriageAgent: jest.fn() }));
jest.mock('../src/services/github-service', () => ({
  createRevertPullRequest: jest.fn(), mergePullRequest: jest.fn(),
}));

const { spawnTriageAgent } = require('../src/services/self-healing-triage-service');
const { emitOasisEvent } = require('../src/services/oasis-event-service');

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body } as any;
}

const AGENT_PARENT = {
  id: 'parent-1111-2222', finding_id: 'finding-1', plan_version: 1, status: 'ci', auto_fix_depth: 0,
  branch: 'dev-autopilot/parent11', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9001', pr_number: 9001,
  metadata: { executor: 'agent', llm_on_ramp: 'deepseek', llm_on_ramp_override: { provider: 'deepseek', model: 'deepseek-flash' } },
};

describe('VTID-04017 isFixModeEligible / buildFixModeInfo / parseFixMode (pure)', () => {
  it('eligible only for stage ci, agent executor, an open PR (number+url+branch), and not DRY_RUN', () => {
    expect(isFixModeEligible(AGENT_PARENT, 'ci', false)).toBe(true);
    expect(isFixModeEligible(AGENT_PARENT, 'ci', true)).toBe(false);
    expect(isFixModeEligible(AGENT_PARENT, 'deploy', false)).toBe(false);
    expect(isFixModeEligible(AGENT_PARENT, 'verification', false)).toBe(false);
    expect(isFixModeEligible({ ...AGENT_PARENT, metadata: { executor: 'single-shot' } }, 'ci', false)).toBe(false);
    expect(isFixModeEligible({ ...AGENT_PARENT, metadata: null }, 'ci', false)).toBe(false);
    expect(isFixModeEligible({ ...AGENT_PARENT, pr_number: null }, 'ci', false)).toBe(false);
    expect(isFixModeEligible({ ...AGENT_PARENT, branch: '' }, 'ci', false)).toBe(false);
    expect(isFixModeEligible({ ...AGENT_PARENT, pr_url: null }, 'ci', false)).toBe(false);
  });

  it('buildFixModeInfo → parseFixMode round-trips; malformed shapes parse to null', () => {
    const info = buildFixModeInfo(AGENT_PARENT);
    expect(info).toEqual({ branch: 'dev-autopilot/parent11', pr_number: 9001, pr_url: AGENT_PARENT.pr_url, parent_execution_id: 'parent-1111-2222' });
    expect(parseFixMode({ fix_mode: info })).toEqual(info);
    expect(parseFixMode({ fix_mode: { ...info, pr_number: '9001' } })).toEqual(info);
    expect(parseFixMode({ fix_mode: { ...info, branch: '' } })).toBeNull();
    expect(parseFixMode({ fix_mode: { ...info, pr_number: 0 } })).toBeNull();
    expect(parseFixMode({ fix_mode: 'nope' })).toBeNull();
    expect(parseFixMode({})).toBeNull();
    expect(parseFixMode(null)).toBeNull();
  });
});

describe('VTID-04017 PR-flood guard exception', () => {
  const prior = { pr_number: 9001, pr_url: AGENT_PARENT.pr_url };
  it('a fix-mode child targeting that PR is not blocked by it', () => {
    expect(priorPrBlocksExecution({ fix_mode: buildFixModeInfo(AGENT_PARENT) }, prior)).toBe(false);
    expect(priorPrBlocksExecution({ fix_mode: { pr_url: AGENT_PARENT.pr_url } }, prior)).toBe(false);
  });
  it('any other open PR, or a row with no fix_mode, still blocks', () => {
    expect(priorPrBlocksExecution({ fix_mode: buildFixModeInfo(AGENT_PARENT) }, { pr_number: 9002, pr_url: 'https://x/pull/9002' })).toBe(true);
    expect(priorPrBlocksExecution({ executor: 'agent' }, prior)).toBe(true);
    expect(priorPrBlocksExecution(null, prior)).toBe(true);
  });
});

describe('VTID-04017 spawnChildExecution carries fix_mode', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('the child row inherits executor/override AND records the fix target; a plain child has no fix_mode', async () => {
    const bodies: any[] = [];
    fetchMock.mockImplementation((_url: string, init?: { body?: string }) => { bodies.push(JSON.parse(init!.body!)); return jsonRes(201, null); });
    const report = { session_id: 't', confidence: 'high', confidence_numeric: 0.9, root_cause_hypothesis: 'x', severity: 'warning', affected_component: 'c', evidence: [], recommended_fix: 'f', elapsed_ms: 1, mode: 'post_failure', raw_output: '' } as any;
    const s = { url: 'https://supa.test', key: 'k' };
    const r = await spawnChildExecution(s, AGENT_PARENT as any, report, 10, 'CI failed: validate-pr\n\nCI log evidence:\n...', buildFixModeInfo(AGENT_PARENT));
    expect(r.ok).toBe(true);
    expect(bodies[0].metadata).toMatchObject({ executor: 'agent', llm_on_ramp: 'deepseek', parent_execution_id: 'parent-1111-2222', fix_mode: { branch: 'dev-autopilot/parent11', pr_number: 9001 } });
    expect(bodies[0].metadata.parent_failure).toContain('CI log evidence');
    expect(bodies[0].auto_fix_depth).toBe(1);
    await spawnChildExecution(s, AGENT_PARENT as any, report, 10, 'err', null);
    expect(bodies[1].metadata.fix_mode).toBeUndefined();
  });
});

describe('VTID-04017 bridgeFailureToSelfHealing in fix mode keeps the PR open', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://supa.test', SUPABASE_SERVICE_ROLE: 'k', DEV_AUTOPILOT_DRY_RUN: 'false', GITHUB_SAFE_MERGE_TOKEN: 'ghs_token' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  function wire(parent: any) {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.includes('/dev_autopilot_executions?id=eq.') && (!init?.method || init.method === 'GET')) return jsonRes(200, [parent]);
      if (url.includes('/dev_autopilot_config')) return jsonRes(200, [{ max_auto_fix_depth: 3, cooldown_minutes: 1, kill_switch: false }]);
      if (url.includes('api.github.com')) return jsonRes(200, {});
      return jsonRes(201, null);
    });
    return calls;
  }

  it('agent parent, stage ci: no GitHub close call, child spawned with fix_mode, event says fix_mode', async () => {
    // The bridge module reads DEV_AUTOPILOT_DRY_RUN at import time; this test
    // file sets it to 'false' before the first import above. isFixModeEligible
    // is also unit-tested with an explicit dryRun argument.
    const calls = wire(AGENT_PARENT);
    (spawnTriageAgent as jest.Mock).mockResolvedValue({ ok: true, report: { session_id: 't', confidence: 'high', confidence_numeric: 0.9, root_cause_hypothesis: 'type error in watcher', severity: 'warning', affected_component: 'c', evidence: [], recommended_fix: 'f', elapsed_ms: 1, mode: 'post_failure', raw_output: '' } });
    const r = await bridgeFailureToSelfHealing({ execution_id: AGENT_PARENT.id, failure_stage: 'ci', error: 'CI failed: validate-pr' });
    expect(r.outcome).toBe('self_heal_injected');
    expect(calls.some((c) => c.url.includes('api.github.com'))).toBe(false);
    const childInsert = calls.find((c) => c.method === 'POST' && c.url.endsWith('/rest/v1/dev_autopilot_executions'))!;
    expect(childInsert.body.metadata.fix_mode).toEqual(buildFixModeInfo(AGENT_PARENT));
    const parentPatch = calls.find((c) => c.method === 'PATCH' && c.url.includes(`id=eq.${AGENT_PARENT.id}`))!;
    expect(parentPatch.body.status).toBe('reverted');
    expect(parentPatch.body.metadata.bridge_fix_mode).toBe(true);
    expect(parentPatch.body.revert_pr_url).toBeNull();
    expect(r.revert_pr_url).toBeUndefined();
    const evt = (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e.type === 'dev_autopilot.execution.self_heal_injected');
    expect(evt.payload).toMatchObject({ fix_mode: true, fix_branch: 'dev-autopilot/parent11', fix_pr_number: 9001 });
  });

  it('single-shot parent, stage ci: the pre-existing path closes the PR and the child has no fix_mode', async () => {
    const parent = { ...AGENT_PARENT, id: 'parent-single', metadata: { executor: 'single-shot' } };
    const calls = wire(parent);
    (spawnTriageAgent as jest.Mock).mockResolvedValue({ ok: true, report: { session_id: 't', confidence: 'high', confidence_numeric: 0.9, root_cause_hypothesis: 'x', severity: 'warning', affected_component: 'c', evidence: [], recommended_fix: 'f', elapsed_ms: 1, mode: 'post_failure', raw_output: '' } });
    const r = await bridgeFailureToSelfHealing({ execution_id: parent.id, failure_stage: 'ci', error: 'CI failed' });
    expect(r.outcome).toBe('self_heal_injected');
    // The bridge reads its GitHub token at import time, so with none the
    // revert helper returns its stub — the point here is that the revert
    // path RAN (revert_pr_url recorded) and no fix target was handed on.
    expect(r.revert_pr_url).toMatch(/#closed/);
    const parentPatch = calls.find((c) => c.method === 'PATCH' && c.url.includes(`id=eq.${parent.id}`))!;
    expect(parentPatch.body.revert_pr_url).toMatch(/#closed/);
    expect(parentPatch.body.metadata.bridge_fix_mode).toBe(false);
    const childInsert = calls.find((c) => c.method === 'POST' && c.url.endsWith('/rest/v1/dev_autopilot_executions'))!;
    expect(childInsert.body.metadata.fix_mode).toBeUndefined();
  });

  it('escalation in fix mode leaves the PR open and names it', async () => {
    const parent = { ...AGENT_PARENT, id: 'parent-deep', auto_fix_depth: 3 };
    const calls = wire(parent);
    (spawnTriageAgent as jest.Mock).mockResolvedValue({ ok: true, report: { session_id: 't', confidence: 'high', confidence_numeric: 0.9, root_cause_hypothesis: 'x', severity: 'warning', affected_component: 'c', evidence: [], recommended_fix: 'f', elapsed_ms: 1, mode: 'post_failure', raw_output: '' } });
    const r = await bridgeFailureToSelfHealing({ execution_id: parent.id, failure_stage: 'ci', error: 'CI failed' });
    expect(r.outcome).toBe('escalated');
    expect(calls.some((c) => c.url.includes('api.github.com'))).toBe(false);
    const evt = (emitOasisEvent as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e.type === 'dev_autopilot.execution.escalated');
    expect(evt.payload.pr_left_open).toBe(AGENT_PARENT.pr_url);
  });
});

describe('VTID-04017 fix-mode task prompt', () => {
  it('names the branch and PR, lists the PR files, carries the CI evidence, forbids starting over or skipping tests', () => {
    const p = buildFixModeTaskPrompt({ vtid: 'VTID-04100', planMarkdown: 'Name the failing checks', prUrl: AGENT_PARENT.pr_url, branch: 'dev-autopilot/parent11', prFiles: ['services/gateway/src/a.ts', 'services/gateway/test/a.test.ts'], ciEvidence: '### validate-pr\nexit 33: outputs/ missing', attempt: 2, maxAttempts: 4 });
    expect(p).toContain('FIX MODE (attempt 2 of 4)');
    expect(p).toContain('branch dev-autopilot/parent11');
    expect(p).toContain(AGENT_PARENT.pr_url);
    expect(p).toContain('- services/gateway/src/a.ts');
    expect(p).toContain('exit 33: outputs/ missing');
    expect(p).toMatch(/not to start over, not to revert its intent, not to open a new PR/);
    expect(p).toMatch(/do not delete or skip a test to get green/);
    expect(p).toMatch(/Reproduce it with run_check/);
  });
  it('degrades honestly with no evidence and no files', () => {
    const p = buildFixModeTaskPrompt({ vtid: 'V', planMarkdown: 'x', prUrl: 'u', branch: 'b', prFiles: [], ciEvidence: '', attempt: 1, maxAttempts: 1 });
    expect(p).toContain('(no evidence captured');
    expect(p).toContain('(none — run_check git_diff');
  });
});

describe('VTID-04017 workspace helpers on an existing branch', () => {
  function fakeExec(log: string[][], stdoutFor: (args: string[]) => string = () => ''): ExecFn {
    return async (cmd, args) => { log.push([cmd, ...args]); return { stdout: stdoutFor(args), stderr: '' }; };
  }

  it('prepareWorkspace(existingBranch) clones the branch itself and does not checkout -b', async () => {
    const log: string[][] = [];
    const ws = await prepareWorkspace({ owner: 'o', repo: 'r', baseBranch: 'main', branch: 'dev-autopilot/parent11', token: 't', workRoot: require('os').tmpdir(), existingBranch: true, exec: fakeExec(log, (a) => (a[0] === 'rev-parse' ? 'abc123\n' : '')) });
    const clone = log.find((l) => l[1] === 'clone')!;
    expect(clone).toContain('dev-autopilot/parent11');
    expect(clone).not.toContain('main');
    expect(log.some((l) => l[1] === 'checkout')).toBe(false);
    expect(ws.branch).toBe('dev-autopilot/parent11');
    expect(ws.baseSha).toBe('abc123');
    await require('fs').promises.rm(ws.root, { recursive: true, force: true });
  });

  it('default prepareWorkspace still clones the base and creates the branch', async () => {
    const log: string[][] = [];
    const ws = await prepareWorkspace({ owner: 'o', repo: 'r', baseBranch: 'main', branch: 'dev-autopilot/new', token: 't', workRoot: require('os').tmpdir(), exec: fakeExec(log, (a) => (a[0] === 'rev-parse' ? 'def456\n' : '')) });
    expect(log.find((l) => l[1] === 'clone')).toContain('main');
    expect(log.find((l) => l[1] === 'checkout')).toEqual(['git', 'checkout', '-b', 'dev-autopilot/new']);
    await require('fs').promises.rm(ws.root, { recursive: true, force: true });
  });

  it('fetchRefSha fetches the base shallowly and returns FETCH_HEAD; listChangedFilesSince diffs against it', async () => {
    const log: string[][] = [];
    const exec = fakeExec(log, (a) => (a[0] === 'rev-parse' ? 'base789\n' : a[0] === 'diff' ? 'M\tservices/gateway/src/a.ts\nA\tservices/gateway/test/a.test.ts\nD\told.ts\nR100\tx.ts\ty.ts\n' : ''));
    expect(await fetchRefSha('/repo', 'main', exec)).toBe('base789');
    expect(log[0]).toEqual(['git', 'fetch', '--depth', '1', 'origin', 'main']);
    const changed = await listChangedFilesSince('/repo', 'base789', exec);
    expect(log.some((l) => l[1] === 'add' && l.includes('--intent-to-add'))).toBe(true);
    expect(log.find((l) => l[1] === 'diff')).toEqual(['git', 'diff', '--name-status', 'base789']);
    expect(changed).toEqual([
      { path: 'services/gateway/src/a.ts', action: 'modify' },
      { path: 'services/gateway/test/a.test.ts', action: 'create' },
      { path: 'old.ts', action: 'delete' },
      { path: 'y.ts', action: 'modify' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it('commitAndPush force-pushes by default and fast-forwards with force:false', async () => {
    const log: string[][] = [];
    const exec = fakeExec(log, (a) => (a[0] === 'rev-parse' ? 'c0ffee\n' : ''));
    await commitAndPush('/repo', { message: 'm', branch: 'b', token: 't', exec });
    expect(log.find((l) => l[1] === 'push')).toEqual(['git', 'push', '--force', '-u', 'origin', 'b']);
    log.length = 0;
    await commitAndPush('/repo', { message: 'm', branch: 'b', token: 't', exec, force: false });
    expect(log.find((l) => l[1] === 'push')).toEqual(['git', 'push', '-u', 'origin', 'b']);
  });
});

describe('VTID-04017 per-run usage on the outcome row', () => {
  const run: AgentRunUsage = {
    execution_id: 'exec-a', vtid: 'VTID-04100', provider: 'deepseek', model: 'deepseek-flash', input_tokens: 1000, output_tokens: 100, cost_usd: 0.0012,
    turns: 9, fix_rounds: 1, checks_refused: 2, fallback_used: false, fix_mode: true, outcome: 'fix_pushed', error: null, elapsed_ms: 5000, recorded_at: '2026-09-17T22:00:00.000Z',
  };

  it('appendAgentRun merges into existing metadata, de-dupes by execution_id, caps, and totals cost', () => {
    const m1 = appendAgentRun({ note: 'keep' }, run);
    expect(m1.note).toBe('keep');
    expect((m1.agent_runs as unknown[]).length).toBe(1);
    const m2 = appendAgentRun(m1, { ...run, execution_id: 'exec-b', cost_usd: 0.0008 });
    expect((m2.agent_runs as unknown[]).length).toBe(2);
    expect(m2.agent_cost_usd_total).toBeCloseTo(0.002, 6);
    const m3 = appendAgentRun(m2, { ...run, cost_usd: 0.01 });
    expect((m3.agent_runs as unknown[]).length).toBe(2);
    expect(m3.agent_cost_usd_total).toBeCloseTo(0.0108, 6);
    expect(appendAgentRun('garbage', run).agent_runs).toHaveLength(1);
    let m: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) m = appendAgentRun(m, { ...run, execution_id: `e${i}` }, 20);
    expect((m.agent_runs as unknown[]).length).toBe(20);
  });

  it('recordAgentRunUsage PATCHes the finding\'s latest outcome row and swallows failures', async () => {
    const ORIGINAL_ENV = process.env;
    process.env = { ...ORIGINAL_ENV, SUPABASE_URL: 'https://supa.test', SUPABASE_SERVICE_ROLE: 'k' };
    jest.resetModules();
    const mod = require('../src/services/dev-autopilot-outcomes') as typeof import('../src/services/dev-autopilot-outcomes');
    fetchMock.mockReset();
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
      if (!init?.method) return jsonRes(200, [{ id: 'out-1', metadata: { x: 1 } }]);
      return jsonRes(204, null);
    });
    await mod.recordAgentRunUsage('finding-1', run);
    expect(calls[0].url).toContain('/rest/v1/dev_autopilot_outcomes?finding_id=eq.finding-1');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url).toContain('id=eq.out-1');
    expect(calls[1].body.metadata).toMatchObject({ x: 1, agent_cost_usd_total: 0.0012 });
    expect(calls[1].body.metadata.agent_runs[0].execution_id).toBe('exec-a');
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(mod.recordAgentRunUsage('finding-1', run)).resolves.toBeUndefined();
    process.env = ORIGINAL_ENV;
  });
});
