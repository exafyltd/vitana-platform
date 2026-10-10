/**
 * VTID-04811: Jev P2 gate E7 — risk hint for a queued High-risk Backoffice
 * command, compared with the approver's decision. Shadow only.
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
import { approvalRiskInput, isApprovalRiskOn, recordApprovalDecision, runApprovalRiskCheck } from '../src/services/jev/gates/approval-risk-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_APPROVAL_RISK_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

function queued(type: string, action: string, payload: Record<string, unknown>, escalations: string[] = []): any {
  return {
    id: `cmd-${type}`, tenant_id: TENANT, requester_id: 'u1', channel: 'web', type, action, tier: 'high', status: 'awaiting_approval',
    payload, resolved_payload: null, idempotency_key: 'k', request_hash: 'h', reason: 'awaiting_approval', approval_id: 'ap1',
    receipt: null, escalations, created_at: '', updated_at: '', executed_at: null,
  };
}

const PAYMENT = queued('finance.payment.submit', 'submit-payment', {
  kind: 'pay', amount: 48000, currency: 'EUR', posting_date: '2026-10-01', party_name: 'Dr. Hans Beispiel', remarks: 'Hans asked to be paid today, his IBAN DE89…',
  allocations: [{ invoice: 'SINV-1' }, { invoice: 'SINV-2' }],
}, ['kind:pay', 'amount>=10000']);
const PAYROLL = queued('finance.journal.submit', 'submit-journal-entry', { tags: ['payroll'], amount: 5200 }, ['tags:payroll']);

function score(level: number, conf = 0.8) {
  const probs = [0.05, 0.05, 0.05, 0.05];
  probs[level] = conf;
  return { ok: true, model: 'jev-1.13.0', answers: { risk: { type: 'score', score: level, probabilities: probs, confidence: conf } }, usage: { input_tokens: 200, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04811 decision and input', () => {
  test('approval_risk: business data, internal plane, redacted, four levels', () => {
    const d = getJevDecision('approval_risk')!;
    expect(d.data).toBe('business');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal']);
    expect((d.questions.risk as any).criteria).toHaveLength(4);
  });
  test('business values by allow-list, other fields by name only; never a counterparty name, remark or the requester', () => {
    const i = approvalRiskInput(PAYMENT)!;
    expect(i).toEqual({
      command_type: 'finance.payment.submit',
      action: 'submit-payment',
      escalations: ['kind:pay', 'amount>=10000'],
      fields: 'amount: 48000\ncurrency: EUR\nkind: pay\nposting date: 2026-10-01\nallocations: 2',
      payload_keys: ['allocations', 'amount', 'currency', 'kind', 'party_name', 'posting_date', 'remarks'],
    });
    const text = JSON.stringify(i);
    for (const bad of ['Hans', 'IBAN', 'u1']) expect(text).not.toContain(bad);
  });
  test('payroll is never sent', () => {
    expect(approvalRiskInput(PAYROLL)).toBeNull();
    expect(approvalRiskInput({ ...PAYMENT, escalations: ['tags:payroll'] })).toBeNull();
  });
});

describe('VTID-04811 gate', () => {
  test('off (default, typo), not queued, or payroll: nothing asked; only payroll writes a skipped row (VTID-05012)', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_APPROVAL_RISK_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isApprovalRiskOn(env)).toBe(false);
      expect(await runApprovalRiskCheck(PAYMENT, 'ap1', { env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(await runApprovalRiskCheck({ ...PAYMENT, status: 'executed' }, 'ap1', { env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runApprovalRiskCheck(PAYROLL, 'ap2', { env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jev_outcome: 'skipped', skip_reason: 'payroll_excluded', subject_ref: 'ap2', cost_usd: 0 });
  });

  test('shadow: one row per approval with the level', async () => {
    const call = jest.fn().mockResolvedValue(score(3));
    expect(await runApprovalRiskCheck(PAYMENT, 'ap1', { env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(call.mock.calls[0][0].state.command).toMatchObject({ type: 'finance.payment.submit', escalations: ['kind:pay', 'amount>=10000'] });
    expect(rows[0]).toMatchObject({
      gate: 'approval_risk', decision: 'approval_risk', mode: 'shadow', plane: 'internal', tenant_id: TENANT,
      subject_type: 'backoffice_approval', subject_ref: 'ap1', system_action: 'queued_for_approval', jev_outcome: 'decided',
      jev_verdict: { level: 3, command_id: PAYMENT.id, command_type: 'finance.payment.submit' },
    });
  });

  test.each([
    [3, 'rejected', true],
    [2, 'rejected', true],
    [1, 'rejected', false],
    [0, 'approved', true],
    [2, 'approved', false],
  ])('level %s, approver %s → agreed %s', async (level, verdict, agreed) => {
    await runApprovalRiskCheck(PAYMENT, 'ap1', { env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(score(level as number)) } });
    await recordApprovalDecision('ap1', verdict as 'approved' | 'rejected', { sb });
    expect(outcomes[0]).toMatchObject({ id: 's1', outcome: `approver_${verdict}`, agreed });
  });

  test('abstained or unavailable → agreed null; no row → nothing; never throws', async () => {
    await runApprovalRiskCheck(PAYMENT, 'ap1', { env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(score(1, 0.3)) } });
    await recordApprovalDecision('ap1', 'approved', { sb });
    expect(outcomes[0]).toMatchObject({ agreed: null });
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runApprovalRiskCheck(PAYMENT, 'ap9', { env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[1]).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0 });
    await recordApprovalDecision('nope', 'approved', { sb });
    await recordApprovalDecision('ap1', 'approved', { sb: null });
    expect(outcomes).toHaveLength(1);
  });
});

describe('VTID-04811 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/backoffice/command-orchestrator.ts'), 'utf8');
  test('scored when queued, after the approval exists; outcome on both verdicts; never awaited', () => {
    const at = src.indexOf('if (isApprovalRiskOn()) void runApprovalRiskCheck(row, approval.id);');
    expect(at).toBeGreaterThan(src.indexOf('row.approval_id = approval.id;'));
    expect(src).toContain("if (isApprovalRiskOn()) void recordApprovalDecision(approval.id, 'rejected');");
    expect(src).toContain("if (isApprovalRiskOn()) void recordApprovalDecision(approval.id, 'approved');");
    expect(src).not.toContain('await runApprovalRiskCheck');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_APPROVAL_RISK_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_APPROVAL_RISK_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_APPROVAL_RISK_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
