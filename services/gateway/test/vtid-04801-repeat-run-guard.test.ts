/**
 * VTID-04801: Jev P2 gate A4 — is a new Dev Autopilot attempt a repeat of
 * one that already failed? Rules for the same plan version, Jev for a new
 * plan; outcome from the run's result. Shadow only.
 */
const rows: any[] = [];
const outcomes: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
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
import { isRepeatRunGuardOn, recordRepeatRunOutcome, runRepeatRunCheck, type RepeatContext } from '../src/services/jev/gates/repeat-run-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_REPEAT_RUN_GUARD_MODE: 'shadow' };
const sb = {} as any;

const PREV = { execution_id: 'exec-prev', plan_version: 2, plan: '1. Add a guard in spawnTriageAgent\n2. Add a test', failure: 'agent hit the 120-turn cap without calling finish' };
const ctx = (over: Partial<RepeatContext> = {}): RepeatContext => ({
  title: 'Retry storm in self-healing triage', plan_version: 3, plan: '1. Add a guard in spawnTriageAgent\n2. Add a test', fix_mode: false, previous: PREV, ...over,
});

function answer(repeat: number, conf = 0.85) {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { repeat: { type: 'noul', noul: repeat }, will_succeed: { type: 'noul', noul: 1 - repeat } },
    usage: { input_tokens: 900, output_tokens: 2 }, latency_ms: 25, attempts: 1,
    _conf: conf,
  };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04801 decision', () => {
  test('execution_repeat: telemetry, internal planes, repeat + will_succeed', () => {
    const d = getJevDecision('execution_repeat')!;
    expect(d.data).toBe('telemetry');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys(d.questions)).toEqual(['repeat', 'will_succeed']);
    expect(d.input.safeParse({ previous_plan: 'a', previous_failure: 'b', new_plan: 'c', fix_mode: false }).success).toBe(true);
  });
});

describe('VTID-04801 gate', () => {
  test('off (default, typo): nothing loaded, asked or written', async () => {
    const load = jest.fn();
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_REPEAT_RUN_GUARD_MODE: 'true' }]) {
      expect(isRepeatRunGuardOn(env)).toBe(false);
      expect(await runRepeatRunCheck({ executionId: 'e1', findingId: 'f1', load, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('no failed attempt in the window: no row', async () => {
    const call = jest.fn();
    expect(await runRepeatRunCheck({ executionId: 'e1', findingId: 'f1', load: async () => ctx({ previous: null }), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('same plan version as the failed attempt: a rules row, no Jev call', async () => {
    const call = jest.fn();
    expect(await runRepeatRunCheck({ executionId: 'e2', findingId: 'f1', load: async () => ctx({ plan_version: 2 }), env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(call).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      gate: 'repeat_run_guard', decision: 'rules:same_plan_version', subject_type: 'dev_autopilot_execution', subject_ref: 'e2',
      jev_outcome: 'decided', jev_verdict: { source: 'rules', repeat: true, previous_execution_id: 'exec-prev' }, cost_usd: 0, system_action: 'dispatch',
    });
  });

  test('a new plan version: Jev compares both plans and the previous failure', async () => {
    const call = jest.fn().mockResolvedValue(answer(0.9));
    expect(await runRepeatRunCheck({ executionId: 'e3', findingId: 'f1', load: async () => ctx(), env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    const st = call.mock.calls[0][0].state;
    expect(st.previous_attempt).toEqual({ plan: PREV.plan, failure: PREV.failure });
    expect(st.new_attempt).toMatchObject({ fix_mode: false });
    expect(rows[0]).toMatchObject({
      decision: 'execution_repeat', jev_outcome: 'decided',
      jev_verdict: { source: 'jev', repeat: true, probability: 0.9, previous_plan_version: 2, plan_version: 3 },
    });
  });

  test('a throwing loader or call never throws and writes nothing', async () => {
    await expect(runRepeatRunCheck({ executionId: 'e', findingId: 'f', load: async () => { throw new Error('db'); }, env: SHADOW, sb })).resolves.toBeNull();
    await expect(runRepeatRunCheck({ executionId: 'e', findingId: 'f', load: async () => ctx(), env: SHADOW, sb, decideOptions: { call: jest.fn().mockRejectedValue(new Error('net')) } })).resolves.toBeNull();
    expect(rows).toHaveLength(0);
  });
});

describe('VTID-04801 outcome', () => {
  test.each([
    [0.9, { ok: false, error: 'tests failed' }, 'run_failed', true],
    [0.9, { ok: true }, 'run_pr_opened', false],
    [0.1, { ok: true }, 'run_pr_opened', true],
    [0.1, { ok: false }, 'run_failed', false],
    [0.9, { ok: false, cancelled: true }, 'run_cancelled', null],
  ])('repeat p=%s, result %j → %s, agreed %s', async (p, result, outcome, agreed) => {
    await runRepeatRunCheck({ executionId: 'e9', findingId: 'f', load: async () => ctx(), env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(p as number)) } });
    await recordRepeatRunOutcome('e9', result as any, { sb });
    expect(outcomes).toEqual([expect.objectContaining({ id: 's1', outcome, agreed })]);
  });

  test('the rules row is judged the same way', async () => {
    await runRepeatRunCheck({ executionId: 'e8', findingId: 'f', load: async () => ctx({ plan_version: 2 }), env: SHADOW, sb });
    await recordRepeatRunOutcome('e8', { ok: false }, { sb });
    expect(outcomes[0]).toMatchObject({ outcome: 'run_failed', agreed: true });
  });

  test('no row (gate off): nothing written', async () => {
    await recordRepeatRunOutcome('never', { ok: true }, { sb });
    expect(outcomes).toHaveLength(0);
  });
});

describe('VTID-04801 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const exec = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  test('beside A2 at the claim, before dispatch, never awaited; outcome written from every applied result', () => {
    const a2 = exec.indexOf('void runClaimFeasibilityCheck(');
    const a4 = exec.indexOf('void runRepeatRunCheck(');
    const dispatch = exec.indexOf('// VTID-02703: dispatch path');
    expect(a2).toBeGreaterThan(-1);
    expect(a4).toBeGreaterThan(a2);
    expect(a4).toBeLessThan(dispatch);
    expect(exec).toContain('if (isRepeatRunGuardOn())');
    const fn = exec.indexOf('export async function applyExecutionResult(');
    expect(exec.slice(fn, fn + 1000)).toContain('void recordRepeatRunOutcome(execId, result);');
  });
  test('the previous attempt is the newest failed one of the same finding in 7 days, never this one', () => {
    expect(exec).toContain('finding_id=eq.${exec.finding_id}&id=neq.${exec.id}&status=in.(${FAILED_EXECUTION_STATUSES.join(\',\')})&created_at=gte.${since}');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_REPEAT_RUN_GUARD_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_REPEAT_RUN_GUARD_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_REPEAT_RUN_GUARD_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
