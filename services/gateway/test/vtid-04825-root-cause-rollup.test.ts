/**
 * VTID-04825: Jev P3 F (second slice) — root cause per Dev Autopilot execution
 * that ended badly, and the weekly roll-up of top classes. Shadow only.
 */
const rows: any[] = [];
let seen: Record<string, boolean> = {};
let ended: any[] = [];
let byGate: Record<string, any[]> = {};
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  fetchRecentShadowBySubject: jest.fn(async (_sb: unknown, _g: string, ref: string) => ({ data: seen[ref] ? { id: 'old' } : null, error: null })),
  fetchEndedExecutions: jest.fn(async () => ({ data: ended, error: null })),
  fetchShadowRowsByGate: jest.fn(async (_sb: unknown, gate: string) => ({ data: byGate[gate] ?? [], error: null })),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import {
  ROOT_CAUSES, classOfRow, classifyEndedExecutions, countClasses, isRootCauseRollupOn, rootCauseInput, ruleRootCause, weeklyRollup, type EndedExecution,
} from '../src/services/jev/gates/root-cause-rollup-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_ROOT_CAUSE_ROLLUP_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

const ex = (id: string, status: string, metadata: Record<string, any> = {}, failure_stage: string | null = null): EndedExecution => ({ id, status, failure_stage, metadata });

function answer(cause: string) {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { cause: { type: 'choice', choice: cause, probabilities: { [cause]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 150, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  seen = {};
  ended = [];
  byGate = {};
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04825 decision, input and rule', () => {
  test('execution_root_cause: telemetry, internal + autopilot planes, redacted, the ten classes', () => {
    const d = getJevDecision('execution_root_cause')!;
    expect(d.data).toBe('telemetry');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys((d.questions as any).cause.criteria)).toEqual([...ROOT_CAUSES]);
  });

  test('input: status, stage and the failure texts, cut; nothing else from metadata', () => {
    const i = rootCauseInput(ex('e1', 'reverted', {
      error: 'x'.repeat(900), gate_reason: 'ci red', failed_checks: [{ name: 'Gateway (Jest)' }, 'lint'], bridge_fix_mode: true,
      ecs_task_arn: 'arn:aws:ecs:secret-ish', ci_log_excerpts: 'long log', triage_session_id: 't',
    }, 'ci'));
    expect(i).toEqual({
      status: 'reverted', failure_stage: 'ci', error: 'x'.repeat(400), gate_reason: 'ci red', bridge_reason: undefined, deploy_error: undefined,
      failed_checks: ['Gateway (Jest)', 'lint'], fix_mode: true, cancelled_by_human: false,
    });
    expect(JSON.stringify(i)).not.toMatch(/arn:aws|long log/);
  });

  test.each([
    [ex('a', 'failed', { error: 'LLM call failed on turn 3: both providers failed: primary=Bedrock invoke_failed: Too many tokens per day' }), 'llm_quota_or_outage'],
    [ex('b', 'failed', { error: 'scope violation after 3 fix round(s): file_outside_allow_scope: services/gateway/specs/command-hub-symbol-index.json' }), 'scope_violation'],
    [ex('c', 'failed', { error: 'agent hit the 40-turn cap without calling finish' }), 'agent_turn_cap'],
    [ex('d', 'reverted', { error: 'reconciler: PR mergeable_state=dirty after 30m' }, 'ci'), 'merge_conflict'],
    [ex('e', 'reverted', { deploy_error: 'ECS rollout failed' }, 'deploy'), 'deploy_failure'],
    [ex('f', 'failed_escalated', {}, 'verification'), 'verification_regression'],
    [ex('g', 'reverted', { failed_checks: ['Gateway (Jest)'] }, 'ci'), 'ci_test_failure'],
    [ex('h', 'cancelled', {}), 'cancelled_by_human'],
    [ex('i', 'failed', { rejected: true }), 'cancelled_by_human'],
    [ex('j', 'failed', {}), null],
  ])('rule: %#', (e, cause) => {
    expect(ruleRootCause(rootCauseInput(e))).toBe(cause);
  });
});

describe('VTID-04825 daily classification', () => {
  test('off (default, typo): nothing read, asked or written', async () => {
    const call = jest.fn();
    ended = [ex('a', 'failed', { error: 'Too many tokens per day' })];
    for (const env of [JEV_ON, { ...JEV_ON, JEV_ROOT_CAUSE_ROLLUP_MODE: 'true' }] as NodeJS.ProcessEnv[]) {
      expect(isRootCauseRollupOn(env)).toBe(false);
      expect(await classifyEndedExecutions('2026-10-01', { sb, env, decideOptions: { call } })).toBe(0);
    }
    expect(call).not.toHaveBeenCalled();
  });

  test('one row per execution; agreement with the rule where it names a class; already-classified skipped', async () => {
    ended = [ex('a', 'failed', { error: 'Too many tokens per day' }), ex('b', 'failed', {}), ex('c', 'cancelled', {}), ex('d', 'reverted', {}, 'deploy')];
    seen.c = true;
    const call = jest.fn()
      .mockResolvedValueOnce(answer('llm_quota_or_outage'))
      .mockResolvedValueOnce(answer('plan_too_broad'))
      .mockResolvedValueOnce(answer('verification_regression'));
    expect(await classifyEndedExecutions('2026-10-01', { sb, env: SHADOW, decideOptions: { call } })).toBe(3);
    expect(rows.map((r) => [r.subject_ref, r.system_action, r.jev_verdict.cause, r.agreed])).toEqual([
      ['a', 'rule_llm_quota_or_outage', 'llm_quota_or_outage', true],
      ['b', 'rule_none', 'plan_too_broad', null],
      ['d', 'rule_deploy_failure', 'verification_regression', false],
    ]);
    expect(rows[0]).toMatchObject({ gate: 'root_cause_rollup', decision: 'execution_root_cause', tenant_id: null, subject_type: 'dev_autopilot_execution', outcome: 'compared_with_text_rule' });
    expect(rows[1]).toMatchObject({ outcome: null, outcome_at: null });
  });

  test('Jev down → fallback row with the rule class; never throws', async () => {
    ended = [ex('a', 'failed', { error: 'Too many tokens per day' })];
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await classifyEndedExecutions('2026-10-01', { sb, env: SHADOW, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0, jev_verdict: { rule_cause: 'llm_quota_or_outage' } });
  });
});

describe('VTID-04825 weekly roll-up', () => {
  test('classOfRow: Jev class first, rule class when Jev did not decide; incident causes, unknown dropped', () => {
    expect(classOfRow({ decision: 'execution_root_cause', jev_verdict: { cause: 'scope_violation', rule_cause: 'ci_test_failure' } })).toEqual({ source: 'execution', cls: 'scope_violation' });
    expect(classOfRow({ decision: 'execution_root_cause', jev_verdict: { reason: 'http_503', rule_cause: 'llm_quota_or_outage' } })).toEqual({ source: 'execution', cls: 'llm_quota_or_outage' });
    expect(classOfRow({ decision: 'execution_root_cause', jev_verdict: { cause: null, rule_cause: null } })).toBeNull();
    expect(classOfRow({ decision: 'ops_error_triage', jev_verdict: { cause: 'provider_outage' } })).toEqual({ source: 'incident', cls: 'provider_outage' });
    expect(classOfRow({ decision: 'ops_error_triage', jev_verdict: { cause: 'unknown' } })).toBeNull();
  });

  test('classes seen at least three times become would_open_finding rows, once per week', async () => {
    byGate.root_cause_rollup = [
      ...['1', '2', '3', '4'].map((i) => ({ id: `q${i}`, decision: 'execution_root_cause', jev_verdict: { cause: 'llm_quota_or_outage' } })),
      { id: 's1', decision: 'execution_root_cause', jev_verdict: { cause: 'scope_violation' } },
      { id: 'old-rollup', decision: 'rules:weekly_rollup', jev_verdict: { class: 'llm_quota_or_outage', count: 9 } },
    ];
    byGate.selfheal_pretriage = ['1', '2', '3'].map((i) => ({ id: `p${i}`, decision: 'ops_error_triage', jev_verdict: { cause: 'provider_outage' } }));
    expect(countClasses([...byGate.root_cause_rollup.slice(0, 5), ...byGate.selfheal_pretriage]).map((c) => [c.source, c.cls, c.count])).toEqual([
      ['execution', 'llm_quota_or_outage', 4], ['incident', 'provider_outage', 3], ['execution', 'scope_violation', 1],
    ]);
    expect(await weeklyRollup('2026-10-05', { sb, env: SHADOW })).toBe(2);
    expect(rows.map((r) => [r.subject_ref, r.system_action, r.jev_verdict.count])).toEqual([
      ['2026-10-05:execution:llm_quota_or_outage', 'would_open_finding', 4],
      ['2026-10-05:incident:provider_outage', 'would_open_finding', 3],
    ]);
    expect(rows[0]).toMatchObject({ decision: 'rules:weekly_rollup', subject_type: 'root_cause_class', cost_usd: 0, jev_verdict: { examples: ['q1', 'q2', 'q3', 'q4'], week_ending: '2026-10-05' } });
    rows.length = 0;
    seen['2026-10-05:execution:llm_quota_or_outage'] = true;
    expect(await weeklyRollup('2026-10-05', { sb, env: SHADOW })).toBe(1);
  });

  test('off: no roll-up', async () => {
    byGate.selfheal_pretriage = ['1', '2', '3'].map((i) => ({ id: `p${i}`, decision: 'ops_error_triage', jev_verdict: { cause: 'provider_outage' } }));
    expect(await weeklyRollup('2026-10-05', { sb, env: JEV_ON })).toBe(0);
  });
});

describe('VTID-04825 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('the gateway starts the scheduler, off unless the mode is set', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    expect(idx).toContain("const { startRootCauseScheduler } = require('./services/jev/gates/root-cause-rollup-gate');");
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_ROOT_CAUSE_ROLLUP_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_ROOT_CAUSE_ROLLUP_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_ROOT_CAUSE_ROLLUP_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
