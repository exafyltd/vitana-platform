/**
 * VTID-04810: Jev P2 gate E5 — duplicate company/customer detection after a
 * CRM create. Shadow only; companies and business fields only.
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
  existingAccountOf, isDuplicateAccountOn, nameSimilarity, newAccountOf, normalisedName, runDuplicateAccountCheck, similarAccounts,
} from '../src/services/jev/gates/duplicate-account-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_CRM_DUPLICATE_ACCOUNT_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

function cmd(type: string, payload: Record<string, unknown>, result: Record<string, unknown> = {}, status = 'executed'): any {
  return {
    id: `cmd-${type}`, tenant_id: TENANT, requester_id: 'u1', channel: 'web', type, action: 'x', tier: 'draft', status,
    payload, resolved_payload: null, idempotency_key: 'k', request_hash: 'h', reason: null, approval_id: null,
    receipt: { status: 'executed', result }, escalations: [], created_at: '', updated_at: '', executed_at: null,
  };
}

const COMPANY = cmd('crm.company.create', { name: 'Acme Longevity GmbH', industry: 'Healthcare', domain: 'acme-longevity.de', lifecycle: 'prospect' }, { id: 'COMP-0009' });
const CUSTOMER = cmd('sales.customer.create', { customer_name: 'ACME Longevity', customer_type: 'Company', customer_group: 'Clinics' }, { name: 'CUST-0042' });
const PERSON = cmd('sales.customer.create', { customer_name: 'Maria Musterfrau', customer_type: 'Individual' }, { name: 'CUST-0043' });

const EXISTING = [
  { id: 'COMP-0009', name: 'Acme Longevity GmbH' }, // the record just created
  { id: 'COMP-0001', company_name: 'ACME Longevity', industry: 'Healthcare' },
  { id: 'COMP-0002', company_name: 'Acme Longevity Holding AG' },
  { id: 'COMP-0003', company_name: 'Beta Clinics' },
  { id: 'COMP-0004', customer_name: 'Hans Acme', customer_type: 'Individual' },
];

function bridgeWith(list: Array<Record<string, unknown>> | null, key = 'companies') {
  return {
    execute: jest.fn(async (req: any) => (list === null
      ? { ok: false, status: 502, error: 'bridge_unreachable' }
      : { ok: true, status: 200, receipt: { status: 'executed', result: { [key]: list }, action: req.action } })),
  } as any;
}
function answer(same: number) {
  return { ok: true, model: 'jev-1.13.0', answers: { same: { type: 'noul', noul: same } }, usage: { input_tokens: 200, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04810 decision and names', () => {
  test('account_duplicate: business data, internal plane, redacted', () => {
    const d = getJevDecision('account_duplicate')!;
    expect(d.data).toBe('business');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal']);
    expect(Object.keys(d.questions)).toEqual(['same']);
  });
  test('names compare without case, punctuation, accents or legal forms', () => {
    expect(normalisedName('Acme Longevity GmbH')).toBe('acme longevity');
    expect(normalisedName('ACME-Longevity, Ltd.')).toBe('acme longevity');
    expect(normalisedName('Zdravlje d.o.o.')).toBe('zdravlje');
    expect(normalisedName('Café Müller AG')).toBe('cafe muller');
    expect(nameSimilarity('Acme Longevity GmbH', 'Acme Longevity Holding AG')).toBeCloseTo(2 / 3);
    expect(nameSimilarity('Acme Longevity', 'Beta Clinics')).toBe(0);
  });
  test('only company creates count; a person customer is never read', () => {
    expect(newAccountOf(COMPANY)).toEqual({ name: 'Acme Longevity GmbH', details: 'industry: Healthcare\ndomain: acme-longevity.de\nlifecycle: prospect', source: 'crm_company', created_id: 'COMP-0009' });
    expect(newAccountOf(CUSTOMER)).toMatchObject({ name: 'ACME Longevity', source: 'erp_customer', details: 'customer group: Clinics' });
    expect(newAccountOf(PERSON)).toBeNull();
    expect(newAccountOf(cmd('crm.lead.create', { company_name: 'Acme' }))).toBeNull();
    expect(existingAccountOf({ id: 'x', customer_name: 'Hans Acme', customer_type: 'Individual' })).toBeNull();
  });
  test('similar accounts: never the record just created, never a person, exact-after-normalising first, at most 3', () => {
    const c = similarAccounts(newAccountOf(COMPANY)!, EXISTING);
    expect(c.map((x) => [x.id, x.rule_same])).toEqual([['COMP-0001', true], ['COMP-0002', false]]);
  });
});

describe('VTID-04810 gate', () => {
  test('off (default, typo), not executed, or no bridge: nothing read, asked or written', async () => {
    const call = jest.fn();
    const bridge = bridgeWith(EXISTING);
    for (const env of [JEV_ON, { ...JEV_ON, JEV_CRM_DUPLICATE_ACCOUNT_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isDuplicateAccountOn(env)).toBe(false);
      expect(await runDuplicateAccountCheck(COMPANY, { bridge, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(await runDuplicateAccountCheck({ ...COMPANY, status: 'failed' }, { bridge, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runDuplicateAccountCheck(COMPANY, { bridge: null, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runDuplicateAccountCheck(PERSON, { bridge, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: reads through the bridge as the requester, asks per candidate, one row; agreement against the name rule', async () => {
    const bridge = bridgeWith(EXISTING);
    const call = jest.fn().mockResolvedValueOnce(answer(0.95)).mockResolvedValueOnce(answer(0.2));
    expect(await runDuplicateAccountCheck(COMPANY, { bridge, env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(bridge.execute.mock.calls[0][0]).toMatchObject({ tenant_id: TENANT, action: 'list-crm-companies', params: { limit: 200, search: 'longevity' }, actor: { user_id: 'u1', channel: 'system' } });
    expect(call.mock.calls[0][0].state).toEqual({
      new_account: { name: 'Acme Longevity GmbH', details: 'industry: Healthcare\ndomain: acme-longevity.de\nlifecycle: prospect' },
      existing_account: { name: 'ACME Longevity', details: 'industry: Healthcare' },
    });
    expect(rows[0]).toMatchObject({
      gate: 'crm_duplicate_account', decision: 'account_duplicate', mode: 'shadow', plane: 'internal', tenant_id: TENANT,
      subject_type: 'crm_company', subject_ref: 'COMP-0009', system_action: 'created', jev_outcome: 'decided',
      jev_verdict: { likely_duplicate: true, command_id: COMPANY.id, candidates: [{ id: 'COMP-0001', rule_same: true, same: true }, { id: 'COMP-0002', rule_same: false, same: false }] },
      agreed: true, outcome: 'compared_with_name_rule',
    });
  });

  test('a customer create reads list-customers; Jev disagreeing with an exact name match is recorded', async () => {
    const bridge = bridgeWith([{ name: 'CUST-0001', customer_name: 'Acme Longevity GmbH', customer_type: 'Company' }], 'customers');
    await runDuplicateAccountCheck(CUSTOMER, { bridge, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(0.1)) } });
    expect(bridge.execute.mock.calls[0][0].action).toBe('list-customers');
    expect(rows[0]).toMatchObject({ subject_type: 'erp_customer', subject_ref: 'CUST-0042', agreed: false });
  });

  test('only similar-but-not-equal names: agreed null; nothing similar: no call, no row', async () => {
    await runDuplicateAccountCheck(COMPANY, { bridge: bridgeWith([{ id: 'C2', company_name: 'Acme Longevity Holding AG' }]), env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(0.9)) } });
    expect(rows[0]).toMatchObject({ agreed: null, outcome: null });
    const call = jest.fn();
    expect(await runDuplicateAccountCheck(COMPANY, { bridge: bridgeWith([{ id: 'C3', company_name: 'Beta Clinics' }]), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test('search refused → one unfiltered retry; bridge down → nothing; Jev down → fallback row; never throws', async () => {
    const flaky = { execute: jest.fn().mockResolvedValueOnce({ ok: false, status: 400, error: 'param_not_allowed' }).mockResolvedValueOnce({ ok: true, status: 200, receipt: { status: 'executed', result: { rows: EXISTING } } }) } as any;
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runDuplicateAccountCheck(COMPANY, { bridge: flaky, env: SHADOW, sb, decideOptions: { call: failing } });
    expect(flaky.execute.mock.calls[1][0].params).toEqual({ limit: 200 });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0, jev_verdict: { likely_duplicate: false, reason: expect.any(String) } });
    expect(await runDuplicateAccountCheck(COMPANY, { bridge: bridgeWith(null), env: SHADOW, sb })).toBeNull();
    const throwing = { execute: jest.fn(async () => { throw new Error('boom'); }) } as any;
    await expect(runDuplicateAccountCheck(COMPANY, { bridge: throwing, env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04810 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('both command paths run the check after the command, never awaited', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/backoffice/command-orchestrator.ts'), 'utf8');
    expect((src.match(/  scoreCrmRecord\(done\);\n  checkDuplicateAccount\(done\);/g) || []).length).toBe(2);
    expect(src).toContain('void runDuplicateAccountCheck(done, { bridge: getErpBridgeClient() });');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_CRM_DUPLICATE_ACCOUNT_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_CRM_DUPLICATE_ACCOUNT_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_CRM_DUPLICATE_ACCOUNT_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
