/**
 * VTID-04782: Jev P1 gates E3 (lead score) + E6 (account classification) on
 * CRM records created through the Backoffice command path. Shadow only;
 * business fields only.
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
import { accountInput, isCrmGatesOn, leadBusinessText, runCrmGates } from '../src/services/jev/gates/crm-gates';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_CRM_LEAD_SCORE_MODE: 'shadow', JEV_CRM_ACCOUNT_CLASSIFICATION_MODE: 'shadow' };
const sb = {} as any;

function cmd(type: string, payload: Record<string, unknown>, result: Record<string, unknown> = {}, status = 'executed'): any {
  return {
    id: `cmd-${type}`, tenant_id: TENANT, requester_id: 'u1', channel: 'web', type, action: 'x', tier: 'draft', status,
    payload, resolved_payload: null, idempotency_key: 'k', request_hash: 'h', reason: null, approval_id: null,
    receipt: { status: 'executed', result }, escalations: [], created_at: '', updated_at: '', executed_at: null,
  };
}

const LEAD = cmd('crm.lead.create', {
  lead_name: 'Maria Musterfrau', email: 'maria@example.com', phone: '+49 170 1234567', mobile: '+49 171 7654321',
  linkedin_url: 'https://linkedin.com/in/maria', notes: 'Met Maria at the fair, call her husband Hans',
  company_name: 'Longevity Clinic Berlin GmbH', industry: 'Healthcare', territory: 'DE', source: 'Trade fair', job_title: 'Medical director',
}, { id: 'LEAD-0007' });

function scoreAnswer(level: number) {
  const probs = [0.05, 0.05, 0.05, 0.05];
  probs[level] = 0.85;
  return { ok: true, model: 'jev-1.13.0', answers: { fit: { type: 'score', score: level, probabilities: probs, confidence: 0.85 } }, usage: { input_tokens: 200, output_tokens: 2 }, latency_ms: 20, attempts: 1 };
}
function kindAnswer(kind: string, conf = 0.9) {
  return { ok: true, model: 'jev-1.13.0', answers: { kind: { type: 'choice', choice: kind, probabilities: { [kind]: conf }, confidence: conf } }, usage: { input_tokens: 150, output_tokens: 2 }, latency_ms: 20, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04782 what is sent', () => {
  test('a lead sends business fields only — never the person, email, phone, LinkedIn or free notes', () => {
    const text = leadBusinessText(LEAD)!;
    expect(text).toBe('company name: Longevity Clinic Berlin GmbH\nindustry: Healthcare\nterritory: DE\nsource: Trade fair\njob title: Medical director');
    expect(text).not.toMatch(/Maria|Musterfrau|example\.com|170|171|linkedin|Hans/i);
  });

  test('a lead with no business field sends nothing', () => {
    expect(leadBusinessText(cmd('crm.lead.create', { lead_name: 'Max', email: 'max@x.de' }))).toBeNull();
  });

  test('a CRM company sends name + business notes; lifecycle implies the kind', () => {
    expect(accountInput(cmd('crm.company.create', { name: 'Acme Supplements', industry: 'Retail', lifecycle: 'Vendor' }))).toEqual({
      name: 'Acme Supplements', notes: 'industry: Retail\nlifecycle: Vendor', implied: 'supplier',
    });
    expect(accountInput(cmd('crm.company.create', { name: 'Acme' }))).toEqual({ name: 'Acme', notes: null, implied: null });
  });

  test('a customer is classified only when it is explicitly a company', () => {
    expect(accountInput(cmd('sales.customer.create', { name: 'Jane Doe', customer_type: 'Individual' }))).toBeNull();
    expect(accountInput(cmd('sales.customer.create', { name: 'Jane Doe' }))).toBeNull();
    expect(accountInput(cmd('sales.customer.create', { name: 'Clinic AG', customer_type: 'Company', customer_group: 'Clinics' }))).toEqual({
      name: 'Clinic AG', notes: 'customer group: Clinics', implied: 'customer',
    });
  });
});

describe('VTID-04782 E3 lead score', () => {
  test('off (default, typo): nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_CRM_LEAD_SCORE_MODE: 'yes' }]) {
      expect(isCrmGatesOn(env)).toBe(false);
      expect(await runCrmGates(LEAD, { env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('shadow: one row per lead, keyed on the ERP lead id, for the tenant', async () => {
    const call = jest.fn().mockResolvedValue(scoreAnswer(3));
    expect(await runCrmGates(LEAD, { env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    const sent = JSON.stringify(call.mock.calls[0][0].state);
    expect(sent).toContain('Longevity Clinic Berlin GmbH');
    expect(sent).not.toMatch(/Maria|example\.com|Hans/);
    expect(rows[0]).toMatchObject({
      gate: 'crm_lead_score', decision: 'lead_score', mode: 'shadow', plane: 'internal', tenant_id: TENANT,
      subject_type: 'crm_lead', subject_ref: 'LEAD-0007', jev_outcome: 'decided',
      jev_verdict: { fit: 3, command_id: 'cmd-crm.lead.create' }, system_action: 'lead_created',
    });
  });

  test('a command that did not execute is never scored', async () => {
    const call = jest.fn();
    expect(await runCrmGates({ ...LEAD, status: 'failed' }, { env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test.each([
    [3, true],
    [2, true],
    [1, false],
  ])('converting a lead scored %s writes agreed=%s', async (level, agreed) => {
    await runCrmGates(LEAD, { env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(scoreAnswer(level)) } });
    await runCrmGates(cmd('crm.lead.convert', { lead_id: 'LEAD-0007' }), { env: SHADOW, sb });
    expect(outcomes).toEqual([expect.objectContaining({ id: 's1', outcome: 'lead_converted', agreed })]);
  });

  test('converting a lead never scored writes nothing', async () => {
    await runCrmGates(cmd('crm.lead.convert', { lead_id: 'LEAD-9999' }), { env: SHADOW, sb });
    expect(outcomes).toHaveLength(0);
  });

  test('a throwing Jev call never throws out of the gate', async () => {
    const call = jest.fn().mockRejectedValue(new Error('net'));
    await expect(runCrmGates(LEAD, { env: SHADOW, sb, decideOptions: { call } })).resolves.toBeNull();
  });
});

describe('VTID-04782 E6 account classification', () => {
  test('a sales customer that Jev also calls a customer: agreed at once', async () => {
    const call = jest.fn().mockResolvedValue(kindAnswer('customer'));
    await runCrmGates(cmd('sales.customer.create', { name: 'Clinic AG', customer_type: 'Company' }, { id: 'CUST-0001' }), { env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0]).toMatchObject({
      gate: 'crm_account_classification', decision: 'account_classification', tenant_id: TENANT,
      subject_type: 'erp_customer', subject_ref: 'CUST-0001', system_action: 'created_as_customer',
      jev_verdict: { kind: 'customer', implied: 'customer' }, agreed: true, outcome: 'compared_with_create_action',
    });
  });

  test('a CRM company created as a vendor that Jev calls a partner: disagreed', async () => {
    const call = jest.fn().mockResolvedValue(kindAnswer('partner'));
    await runCrmGates(cmd('crm.company.create', { name: 'Acme', lifecycle: 'vendor' }), { env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0]).toMatchObject({ subject_type: 'crm_company', system_action: 'created_as_supplier', agreed: false });
  });

  test('a CRM company with no lifecycle: agreed stays null', async () => {
    const call = jest.fn().mockResolvedValue(kindAnswer('prospect'));
    await runCrmGates(cmd('crm.company.create', { name: 'Acme' }), { env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0]).toMatchObject({ system_action: 'created_unspecified', agreed: null, outcome: null, outcome_at: null });
  });

  test('an individual customer is never sent', async () => {
    const call = jest.fn();
    expect(await runCrmGates(cmd('sales.customer.create', { name: 'Jane Doe', customer_type: 'Individual' }), { env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test('each gate has its own mode', async () => {
    const env = { ...JEV_ON, JEV_CRM_ACCOUNT_CLASSIFICATION_MODE: 'shadow' };
    const call = jest.fn().mockResolvedValue(kindAnswer('customer'));
    expect(await runCrmGates(LEAD, { env, sb, decideOptions: { call } })).toBeNull();
    expect(await runCrmGates(cmd('crm.company.create', { name: 'Acme' }), { env, sb, decideOptions: { call } })).toBe('s1');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('VTID-04782 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const orch = fs.readFileSync(path.join(__dirname, '../src/services/backoffice/command-orchestrator.ts'), 'utf8');

  test('both execute paths (direct and approved) run the gates after the command, never awaited', () => {
    expect(orch.match(/rememberForCustomer\(done\);\n  scoreCrmRecord\(done\);/g)).toHaveLength(2);
    expect(orch).toContain("if (done.status !== 'executed' || !isCrmGatesOn()) return;");
    expect(orch).toContain('void runCrmGates(done);');
  });

  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      for (const name of ['JEV_CRM_LEAD_SCORE_MODE', 'JEV_CRM_ACCOUNT_CLASSIFICATION_MODE']) {
        expect(wf).toContain(`{name:"${name}", value:"shadow"}`);
        expect(wf).not.toContain(`{name:"${name}", value:"enforce"}`);
      }
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_CRM_LEAD_SCORE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
    expect(GATEWAY_WORKFLOW_PINS.JEV_CRM_ACCOUNT_CLASSIFICATION_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
