/**
 * VTID-04774: Jev P1 gate A2 — feasibility check at the executor claim.
 * Fire-and-forget in shadow; the outcome is written back from the
 * execution's applied result.
 */
const rows: any[] = [];
const outcomes: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}`, created_at: new Date().toISOString() });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async (_sb: unknown, id: string, patch: any) => {
    outcomes.push({ id, ...patch });
    return { data: null, error: null };
  }),
  fetchRecentShadowRow: jest.fn(async (_sb: unknown, gate: string, ref: string) => {
    const hit = rows.filter((r) => r.gate === gate && r.subject_ref === ref).at(-1);
    return { data: hit ? { id: hit.id, jev_outcome: hit.jev_outcome, jev_verdict: hit.jev_verdict } : null, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { runClaimFeasibilityCheck, recordClaimFeasibilityOutcome, isClaimFeasibilityOn } from '../src/services/jev/gates/claim-feasibility-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_CLAIM_FEASIBILITY_MODE: 'shadow' };
const sb = {} as any;

const ctx = {
  title: 'Retry storm in self-healing triage',
  plan: '## Plan\n1. Add a guard in spawnTriageAgent\n2. Test it',
  files: ['services/gateway/src/services/self-healing-triage-service.ts'],
  fix_mode: false,
  prior_failure: null,
  risk_class: 'low',
  source_type: 'oasis_cluster',
};

function answer(choice: string, conf = 0.85) {
  return {
    ok: true,
    model: 'jev-1.13.0',
    answers: {
      feasibility: { type: 'choice', choice, probabilities: { [choice]: conf }, confidence: conf },
      will_succeed: { type: 'noul', noul: choice === 'feasible' ? 0.8 : 0.2 },
    },
    usage: { input_tokens: 700, output_tokens: 2 },
    latency_ms: 25,
    attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04774 decision', () => {
  test('execution_feasibility: telemetry, internal planes, five verdicts', () => {
    const d = getJevDecision('execution_feasibility')!;
    expect(d.data).toBe('telemetry');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys((d.questions.feasibility as any).criteria)).toEqual(['feasible', 'needs_human', 'needs_infra', 'too_large', 'unclear']);
    expect(d.input.safeParse({ ...ctx, prior_failure: undefined }).success).toBe(true);
  });
});

describe('VTID-04774 check', () => {
  test('off (default, typo): nothing loaded, asked or written', async () => {
    const load = jest.fn();
    const call = jest.fn();
    for (const env of [{}, { JEV_CLAIM_FEASIBILITY_MODE: 'on' }]) {
      expect(isClaimFeasibilityOn(env)).toBe(false);
      expect(await runClaimFeasibilityCheck({ executionId: 'e1', findingId: 'f1', load, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('shadow: one row per execution with the verdict next to the dispatch', async () => {
    const call = jest.fn().mockResolvedValue(answer('needs_infra'));
    const id = await runClaimFeasibilityCheck({ executionId: 'exec-1', findingId: 'find-1', load: async () => ctx, env: SHADOW, sb, decideOptions: { call } });
    expect(id).toBe('s1');
    expect(call.mock.calls[0][0].state.task).toMatchObject({ title: ctx.title, files: ctx.files, fix_mode: false });
    expect(rows[0]).toMatchObject({
      gate: 'claim_feasibility',
      mode: 'shadow',
      subject_type: 'dev_autopilot_execution',
      subject_ref: 'exec-1',
      jev_outcome: 'decided',
      jev_verdict: { feasibility: 'needs_infra', finding_id: 'find-1' },
      system_action: 'dispatch',
    });
  });

  test('a missing plan, a throwing loader or a failing Jev call never throws', async () => {
    expect(await runClaimFeasibilityCheck({ executionId: 'e', findingId: 'f', load: async () => null, env: SHADOW, sb })).toBeNull();
    expect(await runClaimFeasibilityCheck({ executionId: 'e', findingId: 'f', load: async () => { throw new Error('db'); }, env: SHADOW, sb })).toBeNull();
    const failing = jest.fn().mockRejectedValue(new Error('net'));
    // The real client never throws; if one ever does, the gate's own catch
    // swallows it: null, the claim is untouched, and (VTID-05012) only a skipped row records why.
    expect(await runClaimFeasibilityCheck({ executionId: 'e', findingId: 'f', load: async () => ctx, env: SHADOW, sb, decideOptions: { call: failing } })).toBeNull();
    expect(rows.filter((r) => r.jev_outcome === 'skipped').map((r) => r.skip_reason)).toEqual(['no_plan_or_finding', 'error', 'error']);
    expect(rows.every((r) => r.jev_outcome === 'skipped')).toBe(true);
  });
});

describe('VTID-04774 outcome write-back', () => {
  test.each([
    ['feasible', { ok: true }, 'run_pr_opened', true],
    ['feasible', { ok: true, awaiting_approval: true }, 'run_awaiting_approval', true],
    ['feasible', { ok: false, error: 'agent hit the 120-turn cap' }, 'run_failed', false],
    ['needs_infra', { ok: false, error: 'secret missing' }, 'run_failed', true],
    ['too_large', { ok: true }, 'run_pr_opened', false],
    ['unclear', { ok: false, cancelled: true }, 'run_cancelled', null],
  ])('predicted %s, result %j → %s, agreed %s', async (choice, result, outcome, agreed) => {
    await runClaimFeasibilityCheck({ executionId: 'exec-9', findingId: 'f', load: async () => ctx, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(choice)) } });
    await recordClaimFeasibilityOutcome('exec-9', result as any, { sb });
    expect(outcomes).toEqual([expect.objectContaining({ id: 's1', outcome, agreed })]);
  });

  test('an abstained verdict records the outcome with agreed = null', async () => {
    await runClaimFeasibilityCheck({ executionId: 'exec-a', findingId: 'f', load: async () => ctx, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer('feasible', 0.3)) } });
    await recordClaimFeasibilityOutcome('exec-a', { ok: true }, { sb });
    expect(outcomes[0]).toMatchObject({ outcome: 'run_pr_opened', agreed: null });
  });

  test('no row (gate was off) → nothing written, nothing thrown', async () => {
    await expect(recordClaimFeasibilityOutcome('never-checked', { ok: true }, { sb })).resolves.toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });
});

describe('VTID-04774 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const exec = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  test('checked after the claim and the running event, before dispatch, never awaited', () => {
    const running = exec.indexOf("type: 'dev_autopilot.execution.running'");
    const gate = exec.indexOf('void runClaimFeasibilityCheck(');
    const dispatch = exec.indexOf('// VTID-02703: dispatch path');
    expect(running).toBeGreaterThan(-1);
    expect(running).toBeLessThan(gate);
    expect(gate).toBeLessThan(dispatch);
    expect(exec).toContain('if (isClaimFeasibilityOn())');
  });
  test('every applied result writes the outcome first, fire-and-forget', () => {
    const fn = exec.indexOf('export async function applyExecutionResult(');
    const body = exec.slice(fn, fn + 900);
    expect(body).toContain('void recordClaimFeasibilityOutcome(execId, result);');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_CLAIM_FEASIBILITY_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_CLAIM_FEASIBILITY_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_CLAIM_FEASIBILITY_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
