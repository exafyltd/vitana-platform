/**
 * VTID-04815: Jev P3 gate A9 — per-change risk score for a Dev Autopilot
 * diff, compared with how the change landed. Shadow / advisory only.
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
    const r = rows.find((x) => x.id === id);
    if (r) r.outcome = patch.outcome;
    return { data: null, error: null };
  }),
  fetchRecentShadowRow: jest.fn(async (_sb: unknown, gate: string, ref: string) => {
    const hit = rows.filter((r) => r.gate === gate && r.subject_ref === ref).at(-1);
    return { data: hit ? { id: hit.id, jev_outcome: hit.jev_outcome, jev_verdict: hit.jev_verdict, outcome: hit.outcome ?? null } : null, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import {
  PATCH_EXCERPT_CHARS, changeRiskInput, isChangeRiskOn, recordChangeRiskOutcome, runChangeRiskCheck,
} from '../src/services/jev/gates/change-risk-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_CHANGE_RISK_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

const DIFF = {
  stat: ' services/gateway/src/services/diary-service.ts | 12 ++++++----\n services/gateway/test/diary-service.test.ts   | 30 ++++++++++++\n 2 files changed, 36 insertions(+), 6 deletions(-)',
  patch: 'diff --git a/services/gateway/src/services/diary-service.ts b/…\n+  if (!body) return { ok: false };\n',
  files: ['services/gateway/src/services/diary-service.ts', 'services/gateway/test/diary-service.test.ts'],
};
const INPUT = changeRiskInput({ findingTitle: 'Diary: validate empty body', findingRiskClass: 'low', diff: DIFF, fixRounds: 1 });

function score(level: number, conf = 0.8) {
  const probs = [0.05, 0.05, 0.05, 0.05];
  probs[level] = conf;
  return { ok: true, model: 'jev-1.13.0', answers: { risk: { type: 'score', score: level, probabilities: probs, confidence: conf } }, usage: { input_tokens: 900, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04815 decision and input', () => {
  test('change_risk: telemetry, internal planes, redacted, four levels', () => {
    const d = getJevDecision('change_risk')!;
    expect(d.data).toBe('telemetry');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect((d.questions.risk as any).criteria).toHaveLength(4);
  });
  test('built from the runner\'s own diff; tests counted; patch bounded', () => {
    expect(INPUT).toMatchObject({ finding_title: 'Diary: validate empty body', finding_risk_class: 'low', files: DIFF.files, tests_in_diff: 1, fix_rounds: 1 });
    const big = changeRiskInput({ findingTitle: '', diff: { ...DIFF, patch: 'x'.repeat(20_000) }, fixRounds: -3 });
    expect(big.patch_excerpt.length).toBeLessThanOrEqual(PATCH_EXCERPT_CHARS);
    expect(big.patch_excerpt).toContain('more chars]');
    expect(big).toMatchObject({ finding_title: '(untitled)', fix_rounds: 0 });
    expect(big.finding_risk_class).toBeUndefined();
  });
});

describe('VTID-04815 gate', () => {
  test('off (default, typo): nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_CHANGE_RISK_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isChangeRiskOn(env)).toBe(false);
      expect(await runChangeRiskCheck({ executionId: 'e1', input: INPUT, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: one row per pushed change with the level', async () => {
    const call = jest.fn().mockResolvedValue(score(2));
    expect(await runChangeRiskCheck({ executionId: 'e2', input: INPUT, env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(call.mock.calls[0][0].state.change).toMatchObject({ files: DIFF.files, tests_in_diff: 1, fix_rounds: 1 });
    expect(rows[0]).toMatchObject({
      gate: 'change_risk', decision: 'change_risk', mode: 'shadow', subject_type: 'dev_autopilot_execution', subject_ref: 'e2', system_action: 'pushed',
      jev_outcome: 'decided', jev_verdict: { level: 2, files: 2, tests_in_diff: 1, finding_risk_class: 'low' },
    });
  });

  test.each([
    [3, 'ci_failed', true],
    [2, 'verification_failed', true],
    [0, 'verification_failed', false],
    [0, 'verification_passed', true],
    [2, 'verification_passed', false],
  ])('level %s, landed %s → agreed %s', async (level, landing, agreed) => {
    await runChangeRiskCheck({ executionId: 'e3', input: INPUT, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(score(level as number)) } });
    await recordChangeRiskOutcome('e3', landing as any, { sb });
    expect(outcomes[0]).toMatchObject({ id: 's1', outcome: landing, agreed });
  });

  test('the first landing wins; abstained → null; no row or no database → nothing; never throws', async () => {
    await runChangeRiskCheck({ executionId: 'e4', input: INPUT, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(score(3)) } });
    await recordChangeRiskOutcome('e4', 'ci_failed', { sb });
    await recordChangeRiskOutcome('e4', 'verification_passed', { sb });
    expect(outcomes).toHaveLength(1);
    await runChangeRiskCheck({ executionId: 'e5', input: INPUT, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(score(1, 0.3)) } });
    await recordChangeRiskOutcome('e5', 'verification_passed', { sb });
    expect(outcomes[1]).toMatchObject({ agreed: null });
    await recordChangeRiskOutcome('none', 'ci_failed', { sb });
    await recordChangeRiskOutcome('e5', 'ci_failed', { sb: null });
    expect(outcomes).toHaveLength(2);
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runChangeRiskCheck({ executionId: 'e6', input: INPUT, env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows.at(-1)).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0 });
  });
});

describe('VTID-04815 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('runner: new changes only (after the fix-mode return), before the PR opens, never awaited', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');
    const at = src.indexOf('void runChangeRiskCheck({ executionId, input: changeRiskInput(');
    expect(at).toBeGreaterThan(src.indexOf('return finish({ ok: true, pr_url: fixMode.pr_url'));
    expect(at).toBeLessThan(src.indexOf('const pr = await openPullRequest('));
  });
  test('watcher: a CI failure that is not a dirty merge, and every verification verdict', () => {
    const w = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
    expect(w).toContain("if (isChangeRiskOn() && mState !== 'dirty') void recordChangeRiskOutcome(exec.id, 'ci_failed');");
    expect(w).toContain("if (isChangeRiskOn()) void recordChangeRiskOutcome(exec.id, verdict.state === 'pass' ? 'verification_passed' : 'verification_failed');");
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_CHANGE_RISK_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_CHANGE_RISK_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_CHANGE_RISK_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
