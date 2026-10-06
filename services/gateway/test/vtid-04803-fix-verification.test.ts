/**
 * VTID-04803: Jev P2 gate B6 — a second opinion on Dev Autopilot fix
 * verification, next to the rules' verdict. Shadow only.
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
import { isFixVerificationOn, runFixVerificationCheck, verdictText, type FixVerdict } from '../src/services/jev/gates/fix-verification-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_FIX_VERIFICATION_MODE: 'shadow' };
const sb = {} as any;

const CTX = { title: 'Missing tests for diary-service.ts', summary: 'No unit tests cover createEntry', source_type: 'dev_autopilot', files: ['services/gateway/test/diary-service.test.ts'] };
const PASS_NO_PROBE: FixVerdict = { state: 'pass', reason: null, blast_radius: 0, probe: null };
const PASS_PROBED: FixVerdict = { state: 'pass', reason: null, blast_radius: 0, probe: { endpoint: '/api/v1/diary/entries', healthy: true, http_status: 200 } };
const FAIL_PROBE: FixVerdict = { state: 'fail', reason: 'reprobe_unhealthy', blast_radius: 0, probe: { endpoint: '/api/v1/diary/entries', healthy: false, http_status: 500 } };

function answer(resolved: number, sufficient = 0.5) {
  return { ok: true, model: 'jev-1.13.0', answers: { resolved: { type: 'noul', noul: resolved }, evidence_sufficient: { type: 'noul', noul: sufficient } }, usage: { input_tokens: 500, output_tokens: 2 }, latency_ms: 20, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04803 decision', () => {
  test('fix_verification: telemetry, internal planes, resolved + evidence_sufficient', () => {
    const d = getJevDecision('fix_verification')!;
    expect(d.data).toBe('telemetry');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys(d.questions)).toEqual(['resolved', 'evidence_sufficient']);
  });
  test('the rules verdict is described in plain lines', () => {
    expect(verdictText(PASS_NO_PROBE)).toBe('rules verdict: pass\nnew error events from other work in the window: 0\nno probeable endpoint for this finding');
    expect(verdictText(FAIL_PROBE)).toContain('re-probe of /api/v1/diary/entries: unhealthy (500)');
  });
});

describe('VTID-04803 gate', () => {
  test('off (default, typo): nothing loaded, asked or written', async () => {
    const load = jest.fn();
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_FIX_VERIFICATION_MODE: 'on' }]) {
      expect(isFixVerificationOn(env)).toBe(false);
      expect(await runFixVerificationCheck({ executionId: 'e1', verdict: PASS_NO_PROBE, load, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(load).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('a pass with no probe that Jev doubts: disagreement recorded', async () => {
    const call = jest.fn().mockResolvedValue(answer(0.1, 0.2));
    expect(await runFixVerificationCheck({ executionId: 'e2', verdict: PASS_NO_PROBE, load: async () => CTX, env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    const st = call.mock.calls[0][0].state;
    expect(st.change.files).toEqual(CTX.files);
    expect(st.verification).toContain('no probeable endpoint');
    expect(rows[0]).toMatchObject({
      gate: 'fix_verification', subject_type: 'dev_autopilot_execution', subject_ref: 'e2', system_action: 'verification_pass',
      jev_verdict: { resolved: false, evidence_sufficient: 0.2, rule_state: 'pass', probed: false }, agreed: false, outcome: 'compared_with_rules',
    });
  });

  test.each([
    [PASS_PROBED, 0.9, true],
    [FAIL_PROBE, 0.1, true],
    [FAIL_PROBE, 0.9, false],
  ])('rules %j vs Jev resolved p=%s → agreed %s', async (verdict, p, agreed) => {
    await runFixVerificationCheck({ executionId: 'e3', verdict: verdict as FixVerdict, load: async () => CTX, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(p as number)) } });
    expect(rows[0]).toMatchObject({ agreed });
  });

  test('abstained or unavailable: agreed null; missing finding: nothing; never throws', async () => {
    await runFixVerificationCheck({ executionId: 'e4', verdict: PASS_NO_PROBE, load: async () => CTX, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(0.55)) } });
    expect(rows[0]).toMatchObject({ agreed: null, outcome: null });
    await runFixVerificationCheck({ executionId: 'e5', verdict: PASS_NO_PROBE, load: async () => CTX, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 }) } });
    expect(rows[1]).toMatchObject({ jev_outcome: 'fallback', agreed: null });
    expect(await runFixVerificationCheck({ executionId: 'e6', verdict: PASS_NO_PROBE, load: async () => null, env: SHADOW, sb })).toBeNull();
    await expect(runFixVerificationCheck({ executionId: 'e7', verdict: PASS_NO_PROBE, load: async () => { throw new Error('db'); }, env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04803 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const w = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
  test('every verdict branch asks, before the bridge or the completion, never awaited', () => {
    expect((w.match(/secondOpinionOnFix\(s, exec, \{ state: '(pass|fail)'/g) || []).length).toBe(3);
    const blast = w.indexOf("secondOpinionOnFix(s, exec, { state: 'fail', reason: verdict.reason || 'blast_radius'");
    expect(blast).toBeLessThan(w.indexOf("await bridgeFailure(exec.id, 'verification', verdict.reason || 'verification window saw error events'"));
    const pass = w.indexOf("secondOpinionOnFix(s, exec, { state: 'pass'");
    expect(pass).toBeLessThan(w.indexOf("await transitionStatus(s, exec.id, 'verifying', 'completed', {\n      completed_at"));
    expect(w).toContain('void runFixVerificationCheck({ executionId: exec.id, verdict, load: () => loadFixContext(s, exec.finding_id) });');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_FIX_VERIFICATION_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_FIX_VERIFICATION_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_FIX_VERIFICATION_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
