/**
 * VTID-04800: Jev P2 gate A6 — bucket each failing CI check of a Dev
 * Autopilot PR, next to a rule bucket. Shadow only.
 */
const rows: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { isCiFailureRoutingOn, ruleBucket, runCiFailureRouting } from '../src/services/jev/gates/ci-failure-gate';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_CI_FAILURE_ROUTING_MODE: 'shadow' };
const sb = {} as any;

const LOGS = {
  tsc: "src/services/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  jest: 'FAIL test/vtid-04111-foo.test.ts\n  ● foo › returns the right value\n    expect(received).toBe(expected)\nTests:       1 failed, 200 passed',
  npm: 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree',
  runner: 'The runner has received a shutdown signal. This can happen when the runner service is stopped.',
  lint: '/src/x.ts\n  3:1  error  Unexpected console statement  no-console\n✖ 1 problem (1 error, 0 warnings)',
  validate: 'docs/validation/VTID-04111/outputs/ missing',
};

function bucket(b: string, conf = 0.9) {
  return { ok: true, model: 'jev-1.13.0', answers: { bucket: { type: 'choice', choice: b, probabilities: { [b]: conf }, confidence: conf } }, usage: { input_tokens: 400, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04800 rule bucket', () => {
  test.each([
    ['validate-pr', LOGS.validate, 'governance_gate'],
    ['Path Ownership Guard', '', 'governance_gate'],
    ['change-suite', LOGS.jest, 'governance_gate'],
    ['Gateway Service Tests', LOGS.tsc, 'type_error'],
    ['Gateway (Jest, ~7.5k tests)', LOGS.jest, 'test_failure'],
    ['Gateway Service Tests', LOGS.npm, 'dependency'],
    ['Gateway Service Tests', LOGS.runner, 'infrastructure'],
    ['lint', LOGS.lint, 'lint'],
    ['Gateway Service Tests', 'Process completed with exit code 1.', null],
  ])('%s → %s', (name, log, expected) => {
    expect(ruleBucket(name, log)).toBe(expected);
  });
});

describe('VTID-04800 gate', () => {
  test('off (default, typo): nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_CI_FAILURE_ROUTING_MODE: 'yes' }]) {
      expect(isCiFailureRoutingOn(env)).toBe(false);
      expect(await runCiFailureRouting({ executionId: 'e1', failedChecks: ['validate-pr'], evidence: [{ check_name: 'validate-pr', excerpt: LOGS.validate }], env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('no usable log excerpt: nothing asked', async () => {
    const call = jest.fn();
    expect(await runCiFailureRouting({ executionId: 'e1', failedChecks: ['x'], evidence: [{ check_name: 'x', excerpt: 'no log', unavailable: true }, { check_name: 'y', excerpt: '  ' }], env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: one row per execution, Jev and rules per check, agreement where the rules knew', async () => {
    const call = jest.fn().mockResolvedValueOnce(bucket('governance_gate')).mockResolvedValueOnce(bucket('type_error'));
    const id = await runCiFailureRouting({
      executionId: 'exec-7', failedChecks: ['validate-pr', 'Gateway Service Tests'],
      evidence: [{ check_name: 'validate-pr', excerpt: LOGS.validate }, { check_name: 'Gateway Service Tests', excerpt: LOGS.tsc }],
      env: SHADOW, sb, decideOptions: { call },
    });
    expect(id).toBe('s1');
    expect(call.mock.calls[0][0].state.ci_check).toMatchObject({ name: 'validate-pr' });
    expect(rows[0]).toMatchObject({
      gate: 'ci_failure_routing', decision: 'ci_failure_bucket', mode: 'shadow', subject_type: 'dev_autopilot_execution', subject_ref: 'exec-7',
      jev_outcome: 'decided', system_action: 'self_heal_fix_mode', agreed: true, outcome: 'compared_with_rules',
      jev_verdict: { checks: [
        expect.objectContaining({ check: 'validate-pr', jev: 'governance_gate', rule: 'governance_gate' }),
        expect.objectContaining({ check: 'Gateway Service Tests', jev: 'type_error', rule: 'type_error' }),
      ] },
    });
  });

  test('Jev disagrees with a rule on any check: agreed false', async () => {
    const call = jest.fn().mockResolvedValue(bucket('test_failure'));
    await runCiFailureRouting({ executionId: 'e2', failedChecks: ['Gateway Service Tests'], evidence: [{ check_name: 'Gateway Service Tests', excerpt: LOGS.runner }], env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0]).toMatchObject({ agreed: false });
  });

  test('rules unsure: agreed null, Jev answer kept', async () => {
    const call = jest.fn().mockResolvedValue(bucket('test_failure'));
    await runCiFailureRouting({ executionId: 'e3', failedChecks: ['Gateway Service Tests'], evidence: [{ check_name: 'Gateway Service Tests', excerpt: 'Process completed with exit code 1.' }], env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0]).toMatchObject({ agreed: null, outcome: null, jev_verdict: { checks: [expect.objectContaining({ jev: 'test_failure', rule: null })] } });
  });

  test('at most 3 checks asked; Jev unavailable is a fallback row; never throws', async () => {
    const call = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    const ev = Array.from({ length: 5 }, (_, i) => ({ check_name: `c${i}`, excerpt: LOGS.jest }));
    await runCiFailureRouting({ executionId: 'e4', failedChecks: ev.map((e) => e.check_name), evidence: ev, env: SHADOW, sb, decideOptions: { call } });
    expect(call).toHaveBeenCalledTimes(3);
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0 });
    const throwing = jest.fn().mockRejectedValue(new Error('net'));
    await expect(runCiFailureRouting({ executionId: 'e5', failedChecks: ['x'], evidence: [{ check_name: 'x', excerpt: LOGS.jest }], env: SHADOW, sb, decideOptions: { call: throwing } })).resolves.toBeNull();
  });
});

describe('VTID-04800 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const w = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
  test('runs after the evidence is collected and before the self-heal bridge, never awaited', () => {
    const evid = w.indexOf('const evidence = headSha');
    const gate = w.indexOf('if (isCiFailureRoutingOn()) void runCiFailureRouting({ executionId: exec.id, failedChecks: analysis.failedNames, evidence });');
    const bridge = w.indexOf("await bridgeFailure(exec.id, 'ci', failureReasonWithEvidence);");
    expect(evid).toBeGreaterThan(-1);
    expect(evid).toBeLessThan(gate);
    expect(gate).toBeLessThan(bridge);
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_CI_FAILURE_ROUTING_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_CI_FAILURE_ROUTING_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_CI_FAILURE_ROUTING_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
