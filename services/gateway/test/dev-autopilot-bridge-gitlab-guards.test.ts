/**
 * Guards of the self-healing bridge (services/dev-autopilot-bridge.ts), owner instruction 2026-11-19:
 * "Add guards so the bridge cannot close PRs, delete branches, or alter an MR-owned branch. It must fail safely for unsupported
 * execution states."
 *
 *   G1  an execution on a GitLab merge-request branch is never handled by the bridge: no triage, no PR close, no branch delete, no
 *       child, no status write. The delivery loop owns its next attempt, from GitLab's own pipeline.
 *   G2  an execution in a state the bridge does not handle (queued, cooling, held, awaiting approval, cancelled, completed, archived,
 *       ...) is refused before the first write. The states every existing caller leaves a failed row in still bridge as before.
 *   and, behind G1, every destructive helper refuses a GitLab-hosted row on its own (revertExecutionPR, isFixModeEligible,
 *   spawnChildExecution), so no future caller can reach the GitHub branch through them.
 *
 * Live settings on purpose (DEV_AUTOPILOT_DRY_RUN=false and a GitHub token): without the guards these paths make real GitHub calls.
 * Every request is recorded; a test fails if any write or any GitHub call happens.
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event' }),
}));
jest.mock('../src/services/self-healing-triage-service', () => ({
  spawnTriageAgent: jest.fn(),
}));

type Call = { method: string; url: string };
const calls: Call[] = [];
let row: Record<string, unknown>;

const SUPA_URL = 'https://supa.test';
const SHA = '0123456789abcdef0123456789abcdef01234567';

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body } as Response;
}

const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
  const method = (init?.method || 'GET').toUpperCase();
  calls.push({ method, url });
  if (url.includes('/rest/v1/dev_autopilot_executions?id=eq.') && method === 'GET') return respond(200, [row]);
  if (url.includes('/rest/v1/dev_autopilot_config')) return respond(200, [{ max_auto_fix_depth: 2, cooldown_minutes: 10, kill_switch: false }]);
  if (url.includes('api.github.com')) return respond(200, {});
  if (method === 'POST' || method === 'PATCH') return respond(201, {});
  return respond(200, []);
});
global.fetch = fetchMock as unknown as typeof fetch;

/** The bridge reads DRY_RUN and the GitHub token at load: load it fresh with live settings, with the triage mock of that registry. */
function loadBridge() {
  let bridge: any;
  let triage: any;
  jest.isolateModules(() => {
    Object.assign(process.env, {
      SUPABASE_URL: SUPA_URL,
      SUPABASE_SERVICE_ROLE: 'service-role-key',
      DEV_AUTOPILOT_DRY_RUN: 'false',
      GITHUB_SAFE_MERGE_TOKEN: 'ghp-placeholder-not-real',
      DEV_AUTOPILOT_GITHUB_TOKEN: 'ghp-placeholder-not-real',
    });
    triage = require('../src/services/self-healing-triage-service');
    bridge = require('../src/services/dev-autopilot-bridge');
  });
  triage.spawnTriageAgent.mockResolvedValue({
    ok: true,
    report: {
      session_id: 's', severity: 'warning', root_cause_hypothesis: 'x', affected_component: 'x', evidence: [], recommended_fix: 'x',
      confidence: 'high', confidence_numeric: 0.9, elapsed_ms: 1, mode: 'post_failure', raw_output: '',
    },
  });
  return { bridge, triage };
}

const writes = () => calls.filter((c) => c.method !== 'GET');
const githubCalls = () => calls.filter((c) => c.url.includes('github.com'));

function githubRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-2222-3333-4444-555555555555', finding_id: 'f0000000-0000-0000-0000-000000000001', plan_version: 1, status: 'failed',
    auto_fix_depth: 0, branch: 'dev-autopilot/11111111', pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9001', pr_number: 9001,
    parent_execution_id: null, self_healing_vtid: null, triage_report: null, metadata: { executor: 'single-shot' }, ...over,
  };
}

/** A GitLab-native repair execution. It even carries GitHub-looking PR fields, the worst case: they must never be used. */
function gitlabRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return githubRow({
    branch: 'delivery-loop/fix-greeting',
    metadata: {
      host: 'gitlab', executor: 'agent', source: 'delivery-loop',
      gitlab: {
        project_path: 'vitana/vitana-platform', mr_iid: 12, mr_url: null, source_branch: 'delivery-loop/fix-greeting', target_branch: 'main',
        pipeline_id: 31, sha: SHA, work_key: 'repair:k', dispatch_key: 'intent:repair:k:1',
      },
    },
    ...over,
  });
}

beforeEach(() => {
  calls.length = 0;
  fetchMock.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('G1: an execution on a GitLab merge-request branch', () => {
  it.each(['failed', 'running', 'ci'])('in status %s is refused with no triage, no GitHub call and no write', async (status) => {
    row = gitlabRow({ status });
    const { bridge, triage } = loadBridge();
    const r = await bridge.bridgeFailureToSelfHealing({ execution_id: String(row.id), failure_stage: 'ci', error: 'pipeline 31 failed' });
    expect(r).toEqual(expect.objectContaining({ ok: false, outcome: 'unsupported_execution', execution_id: row.id }));
    expect(r.error).toMatch(/GitLab/i);
    expect(triage.spawnTriageAgent).not.toHaveBeenCalled();
    expect(githubCalls()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('is refused even when the row only claims to be GitLab-hosted (a malformed gitlab block)', async () => {
    row = githubRow({ metadata: { host: 'gitlab' } });
    const { bridge } = loadBridge();
    const r = await bridge.bridgeFailureToSelfHealing({ execution_id: String(row.id), failure_stage: 'ci' });
    expect(r.outcome).toBe('unsupported_execution');
    expect(writes()).toEqual([]);
    expect(githubCalls()).toEqual([]);
  });

  it('revertExecutionPR refuses it on its own: no PR close and no branch delete', async () => {
    const { bridge } = loadBridge();
    const r = await bridge.revertExecutionPR(gitlabRow(), 'ci');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GitLab/i);
    expect(calls).toEqual([]);
  });

  it('isFixModeEligible is false for it, whatever PR fields it carries', () => {
    const { bridge } = loadBridge();
    expect(bridge.isFixModeEligible(gitlabRow(), 'ci', false)).toBe(false);
    expect(bridge.isFixModeEligible(githubRow({ metadata: { executor: 'agent' } }), 'ci', false)).toBe(true); // GitHub unchanged
  });

  it('spawnChildExecution refuses a GitLab-hosted parent: no child row is written', async () => {
    const { bridge } = loadBridge();
    const r = await bridge.spawnChildExecution({ url: SUPA_URL, key: 'k' }, gitlabRow(), { confidence: 'high', confidence_numeric: 0.9 }, 0, 'x', null);
    expect(r.ok).toBe(false);
    expect(writes()).toEqual([]);
  });
});

describe('G2: execution states the bridge does not handle', () => {
  it.each(['queued', 'cooling', 'held_overlap', 'awaiting_approval', 'cancelled', 'completed', 'auto_archived', 'self_healed', 'reverted', 'failed_escalated'])(
    '%s is refused before the first write, with no triage and no GitHub call',
    async (status) => {
      row = githubRow({ status });
      const { bridge, triage } = loadBridge();
      const r = await bridge.bridgeFailureToSelfHealing({ execution_id: String(row.id), failure_stage: 'ci', error: 'x' });
      expect(r).toEqual(expect.objectContaining({ ok: false, outcome: 'unsupported_state', execution_id: row.id }));
      expect(r.error).toContain(status);
      expect(triage.spawnTriageAgent).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
      expect(githubCalls()).toEqual([]);
    },
  );

  it('a row that was bridged already still answers already_bridged (the order of the checks keeps the callers\' ledger handling)', async () => {
    row = githubRow({ status: 'reverted', triage_report: { confidence: 'high' }, self_healing_vtid: 'VTID-DA-11111111' });
    const { bridge } = loadBridge();
    const r = await bridge.bridgeFailureToSelfHealing({ execution_id: String(row.id), failure_stage: 'ci' });
    expect(r.outcome).toBe('already_bridged');
    expect(writes()).toEqual([]);
  });

  it.each(['failed', 'running', 'ci', 'merging', 'deploying', 'verifying'])('%s, a state the existing callers leave a failed row in, is still bridged', async (status) => {
    row = githubRow({ status });
    const { bridge, triage } = loadBridge();
    await bridge.bridgeFailureToSelfHealing({ execution_id: String(row.id), failure_stage: 'ci', error: 'x' });
    expect(triage.spawnTriageAgent).toHaveBeenCalledTimes(1);
  });

  it('BRIDGEABLE_STATUSES is exactly those states', () => {
    const { bridge } = loadBridge();
    expect([...bridge.BRIDGEABLE_STATUSES].sort()).toEqual(['ci', 'deploying', 'failed', 'merging', 'running', 'verifying']);
  });
});
