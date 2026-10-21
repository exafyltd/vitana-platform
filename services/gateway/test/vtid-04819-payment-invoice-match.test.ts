/**
 * VTID-04819: Jev P3 gate E8 — payment ↔ invoice match on an executed
 * allocation. Shadow only; a party's name is never sent.
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
import {
  allocationIds, isPaymentMatchOn, matchInput, recordOf, ruleMatch, runPaymentMatchCheck,
} from '../src/services/jev/gates/payment-match-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_PAYMENT_INVOICE_MATCH_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

function cmd(type: string, payload: Record<string, unknown>, status = 'executed'): any {
  return {
    id: `cmd-${type}`, tenant_id: TENANT, requester_id: 'u1', channel: 'web', type, action: 'allocate-payment', tier: 'commit', status,
    payload, resolved_payload: null, idempotency_key: 'k', request_hash: 'h', reason: null, approval_id: null,
    receipt: { status: 'executed', result: {} }, escalations: [], created_at: '', updated_at: '', executed_at: null,
  };
}
const ALLOC = cmd('finance.payment.allocate', { payment_id: 'PAY-0007', invoice_id: 'SINV-0042', allocated_amount: 480 });
const PAYMENT = { name: 'PAY-0007', paid_amount: 480, currency: 'EUR', posting_date: '2026-09-30', reference_no: 'Transfer SINV-0042', party: 'Maria Musterfrau' };
const INVOICE = { name: 'SINV-0042', grand_total: 480, outstanding_amount: 480, currency: 'EUR', due_date: '2026-10-15', customer: 'maria  musterfrau' };

function bridge(payment: unknown = { payment: PAYMENT }, invoice: unknown = { invoice: INVOICE }) {
  return {
    execute: jest.fn(async (req: any) => ({
      ok: true, status: 200,
      receipt: { status: 'executed', result: req.action === 'get-payment' ? payment : invoice },
    })),
  } as any;
}
function answer(p: number, issue = 'none') {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { matches: { type: 'noul', noul: p }, issue: { type: 'choice', choice: issue, probabilities: { [issue]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 200, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04819 decision and input', () => {
  test('payment_invoice_match: business data, internal plane, redacted', () => {
    const d = getJevDecision('payment_invoice_match')!;
    expect(d.data).toBe('business');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal']);
    expect(Object.keys((d.questions.issue as any).criteria)).toContain('party_mismatch');
  });
  test('ids, records and the input; the party is compared here and never sent', () => {
    expect(allocationIds(ALLOC)).toEqual({ payment_id: 'PAY-0007', invoice_id: 'SINV-0042', allocated: 480 });
    expect(recordOf({ invoice: INVOICE }, 'invoice')).toBe(INVOICE);
    expect(recordOf({ data: INVOICE }, 'invoice')).toBe(INVOICE);
    const i = matchInput(PAYMENT, INVOICE, 480);
    expect(i).toEqual({
      payment_amount: 480, payment_currency: 'EUR', payment_date: '2026-09-30', payment_reference: 'Transfer SINV-0042', allocated_amount: 480,
      invoice_total: 480, invoice_outstanding_before: 480, invoice_currency: 'EUR', invoice_due_date: '2026-10-15', invoice_number: 'SINV-0042',
      same_party: true, reference_mentions_invoice: true,
    });
    expect(JSON.stringify(i).toLowerCase()).not.toContain('musterfrau');
  });
  test.each([
    [{}, true],
    [{ same_party: false }, false],
    [{ invoice_currency: 'USD' }, false],
    [{ allocated_amount: 200 }, null],
    [{ same_party: null }, null],
  ])('rule %j → %s', (patch, expected) => {
    expect(ruleMatch({ ...matchInput(PAYMENT, INVOICE, 480), ...(patch as object) })).toBe(expected);
  });
});

describe('VTID-04819 gate', () => {
  test('off (default, typo), another command, not executed, no bridge: nothing read, asked or written', async () => {
    const b = bridge();
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_PAYMENT_INVOICE_MATCH_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isPaymentMatchOn(env)).toBe(false);
      expect(await runPaymentMatchCheck(ALLOC, { bridge: b, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(await runPaymentMatchCheck(cmd('finance.payment.submit', {}), { bridge: b, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runPaymentMatchCheck({ ...ALLOC, status: 'failed' }, { bridge: b, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runPaymentMatchCheck(ALLOC, { bridge: null, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(b.execute).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: reads both records through the bridge as the requester; one row; agreement against the rule', async () => {
    const b = bridge();
    const call = jest.fn().mockResolvedValue(answer(0.95));
    expect(await runPaymentMatchCheck(ALLOC, { bridge: b, env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(b.execute.mock.calls.map((c: any) => [c[0].action, c[0].params, c[0].actor])).toEqual([
      ['get-payment', { payment_id: 'PAY-0007' }, { user_id: 'u1', channel: 'system' }],
      ['get-sales-invoice', { invoice_id: 'SINV-0042' }, { user_id: 'u1', channel: 'system' }],
    ]);
    expect(JSON.stringify(call.mock.calls[0][0].state).toLowerCase()).not.toContain('musterfrau');
    expect(rows[0]).toMatchObject({
      gate: 'payment_invoice_match', decision: 'payment_invoice_match', tenant_id: TENANT, subject_type: 'erp_payment_allocation',
      subject_ref: 'PAY-0007->SINV-0042', system_action: 'allocated', jev_verdict: { matches: true, rule: true, same_party: true, command_id: ALLOC.id },
      agreed: true, outcome: 'compared_with_match_rule',
    });
  });

  test('a different party: Jev saying it matches disagrees with the rule', async () => {
    await runPaymentMatchCheck(ALLOC, { bridge: bridge({ payment: { ...PAYMENT, party: 'Someone Else' } }), env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(0.9)) } });
    expect(rows[0]).toMatchObject({ jev_verdict: { same_party: false, rule: false }, agreed: false });
  });

  test('records missing, ids missing, bridge throwing → nothing; Jev down → fallback row; never throws', async () => {
    const call = jest.fn();
    expect(await runPaymentMatchCheck(ALLOC, { bridge: bridge(null), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runPaymentMatchCheck(cmd('finance.payment.allocate', { payment_id: 'PAY-1' }), { bridge: bridge(), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runPaymentMatchCheck(ALLOC, { bridge: bridge(), env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0 });
    const throwing = { execute: jest.fn(async () => { throw new Error('boom'); }) } as any;
    await expect(runPaymentMatchCheck(ALLOC, { bridge: throwing, env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04819 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('both command paths run the check after the command, never awaited', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/backoffice/command-orchestrator.ts'), 'utf8');
    expect((src.match(/  checkDuplicateAccount\(done\);\n  checkPaymentMatch\(done\);/g) || []).length).toBe(2);
    expect(src).toContain('void runPaymentMatchCheck(done, { bridge: getErpBridgeClient() });');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_PAYMENT_INVOICE_MATCH_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_PAYMENT_INVOICE_MATCH_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_PAYMENT_INVOICE_MATCH_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
