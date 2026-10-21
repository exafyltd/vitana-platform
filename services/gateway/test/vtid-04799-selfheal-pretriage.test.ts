/**
 * VTID-04799: Jev P2 gate B3 — pre-triage cause class for self-healing
 * incidents that are not provider failures. Shadow; enforce (off) skips
 * triage only for a decided "transient".
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
  fetchRecentShadowBySubject: jest.fn(async () => ({ data: null, error: null })),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { recordPretriageOutcome, recordSelfHealGateOutcome, runSelfHealGates } from '../src/services/jev/gates/selfheal-gates';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_SELFHEAL_PRETRIAGE_MODE: 'shadow' } as NodeJS.ProcessEnv;
const ENFORCE = { ...JEV_ON, JEV_SELFHEAL_PRETRIAGE_MODE: 'enforce' } as NodeJS.ProcessEnv;
const sb = {} as any;

const CODE_BUG = { vtid: 'VTID-09001', mode: 'pre_fix', endpoint: '/api/v1/diary/entries', failure: { endpoint: '/api/v1/diary/entries', error: "TypeError: Cannot read properties of undefined (reading 'user_id')" } };
const PROVIDER = { vtid: 'VTID-09002', mode: 'pre_fix', failure: { error: 'LLM call failed: triage - Bedrock invoke_failed: Operation not allowed' } };

function triageAnswer(cause: string, needsHuman = 0.7, conf = 0.85) {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { cause: { type: 'choice', choice: cause, probabilities: { [cause]: conf }, confidence: conf }, needs_human: { type: 'noul', noul: needsHuman } },
    usage: { input_tokens: 250, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04799 B3 pre-triage', () => {
  test('off (default, typo): nothing asked or written; B1/B2 unaffected', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_SELFHEAL_PRETRIAGE_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      const g = await runSelfHealGates(CODE_BUG, { env, sb, decideOptions: { call } });
      expect(g.skip).toBeNull();
      expect(g.pretriage).toMatchObject({ mode: 'off', cause: null, shadow_id: null });
    }
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('shadow: a non-provider incident gets one row with the cause and needs-human', async () => {
    const call = jest.fn().mockResolvedValue(triageAnswer('code_defect', 0.8));
    const g = await runSelfHealGates(CODE_BUG, { env: SHADOW, sb, decideOptions: { call } });
    expect(g.skip).toBeNull();
    expect(call.mock.calls[0][0].state.error_event).toMatchObject({
      service: '/api/v1/diary/entries', topic: 'self-healing:pre_fix', message: expect.stringContaining('TypeError'),
    });
    expect(g.pretriage).toMatchObject({ mode: 'shadow', cause: 'code_defect', needs_human: true, shadow_id: 's1' });
    expect(rows[0]).toMatchObject({
      gate: 'selfheal_pretriage', decision: 'ops_error_triage', mode: 'shadow', subject_type: 'triage', subject_ref: 'VTID-09001',
      jev_outcome: 'decided', jev_verdict: { cause: 'code_defect', needs_human: true }, system_action: 'triage',
    });
  });

  test('a provider failure is B2’s, never B3’s', async () => {
    const call = jest.fn();
    const g = await runSelfHealGates(PROVIDER, { env: SHADOW, sb, decideOptions: { call } });
    expect(call).not.toHaveBeenCalled();
    expect(g.pretriage?.shadow_id).toBeNull();
  });

  test('no failure text: nothing asked', async () => {
    const call = jest.fn();
    await runSelfHealGates({ vtid: 'VTID-09003', mode: 'pre_fix', endpoint: '/x' }, { env: SHADOW, sb, decideOptions: { call } });
    expect(call).not.toHaveBeenCalled();
  });

  test('enforce skips triage only for a decided transient', async () => {
    let g = await runSelfHealGates(CODE_BUG, { env: ENFORCE, sb, decideOptions: { call: jest.fn().mockResolvedValue(triageAnswer('transient', 0.1)) } });
    expect(g.skip).toEqual({ gate: 'selfheal_pretriage', reason: 'pretriage_transient' });
    g = await runSelfHealGates(CODE_BUG, { env: ENFORCE, sb, decideOptions: { call: jest.fn().mockResolvedValue(triageAnswer('transient', 0.1, 0.4)) } });
    expect(g.skip).toBeNull(); // abstained → triage runs
    g = await runSelfHealGates(CODE_BUG, { env: ENFORCE, sb, decideOptions: { call: jest.fn().mockResolvedValue(triageAnswer('configuration')) } });
    expect(g.skip).toBeNull();
  });

  test('Jev unavailable: a fallback row, triage runs', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    const g = await runSelfHealGates(CODE_BUG, { env: ENFORCE, sb, decideOptions: { call: failing } });
    expect(g.skip).toBeNull();
    expect(rows[0]).toMatchObject({ gate: 'selfheal_pretriage', jev_outcome: 'fallback' });
  });

  test.each([
    ['transient', 'info', true],
    ['transient', 'critical', false],
    ['code_defect', 'warning', true],
    ['configuration', 'info', false],
  ])('agreement: Jev %s vs triage report %s → %s', async (cause, severity, agreed) => {
    const g = await runSelfHealGates(CODE_BUG, { env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(triageAnswer(cause)) } });
    await recordPretriageOutcome(g, { severity }, sb);
    expect(outcomes).toEqual([expect.objectContaining({ id: 's1', outcome: `triage_ok:${severity}`, agreed })]);
  });

  test('a triage that failed or was skipped: outcome without agreement', async () => {
    const g = await runSelfHealGates(CODE_BUG, { env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(triageAnswer('code_defect')) } });
    await recordSelfHealGateOutcome(g, { ok: false, error: 'router returned ok=false' }, sb);
    expect(outcomes).toEqual([expect.objectContaining({ id: 's1', agreed: null })]);
  });
});

describe('VTID-04799 wiring', () => {
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/self-healing-triage-service.ts'), 'utf8');
  test('the report write-back runs after the report is parsed, never awaited', () => {
    const parsed = svc.indexOf('const report = parseTriageReport(');
    const back = svc.indexOf('void recordPretriageOutcome(gates, report);');
    expect(parsed).toBeGreaterThan(-1);
    expect(back).toBeGreaterThan(parsed);
  });
});

describe('VTID-04799 pins', () => {
  test('both gateways pin shadow, never enforce', () => {
    const root = path.resolve(__dirname, '../../..');
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_SELFHEAL_PRETRIAGE_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_SELFHEAL_PRETRIAGE_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_SELFHEAL_PRETRIAGE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
