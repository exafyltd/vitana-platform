/**
 * VTID-04822: Jev P3 E2 — document type routing for Exafy company documents.
 * Shadow only; the search result is unchanged.
 */
const rows: any[] = [];
let seen: Record<string, boolean> = {};
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  fetchRecentShadowBySubject: jest.fn(async (_sb: unknown, _gate: string, ref: string) => ({ data: seen[ref] ? { id: 'old' } : null, error: null })),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { DOCUMENT_ROUTES, DOCUMENT_TYPES, isDocumentTypeRoutingOn, ruleDocType, runDocumentTypeRouting } from '../src/services/jev/gates/document-type-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';
import type { CompanyDoc } from '../src/services/company-docs/company-docs';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_DOCUMENT_TYPE_ROUTING_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const TENANT = '11111111-1111-4111-8111-111111111111';

const doc = (id: string, name: string, mime: string | null = 'application/pdf', provider: 'google' | 'microsoft' = 'google'): CompanyDoc =>
  ({ provider, id, name, mime, modified: '2026-09-01T00:00:00Z', url: `https://x/${id}` });

function answer(type: string) {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { type: { type: 'choice', choice: type, probabilities: { [type]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 120, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  seen = {};
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04822 decision and rule', () => {
  test('document_type: business data, internal plane, redacted, every type has a route', () => {
    const d = getJevDecision('document_type')!;
    expect(d.data).toBe('business');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal']);
    expect(Object.keys((d.questions as any).type.criteria)).toEqual([...DOCUMENT_TYPES]);
    for (const t of DOCUMENT_TYPES) expect(DOCUMENT_ROUTES[t]).toBeTruthy();
    expect(DOCUMENT_ROUTES.contract).toBe('clause_review');
    expect(DOCUMENT_ROUTES.invoice).toBe('payment_match');
  });
  test.each([
    ['Partner_Agreement_2026.pdf', 'pdf', 'contract'],
    ['Mietvertrag Büro Wien', 'document', 'contract'],
    ['Ugovor o saradnji', 'document', 'contract'],
    ['NDA - Acme', 'pdf', 'contract'],
    ['Rechnung zum Vertrag 0042', 'pdf', 'invoice'],
    ['Račun 12-2026', 'pdf', 'invoice'],
    ['Eingangsrechnung September', 'spreadsheet', 'invoice'],
    ['Angebot Website Relaunch', 'pdf', 'quote_or_order'],
    ['Purchase order 77', 'pdf', 'quote_or_order'],
    ['Datenschutz-Richtlinie', 'document', 'policy'],
    ['Lastenheft ORB', 'document', 'specification'],
    ['PRD - voice v2', 'document', 'specification'],
    ['Handelsregisterauszug Exafy', 'pdf', 'legal_corporate'],
    ['Lebenslauf', 'pdf', 'hr'],
    ['Q3 Bericht', 'document', 'report'],
    ['Investor deck', 'other', 'presentation'],
    ['Untitled', 'presentation', 'presentation'],
    ['Notes from Tuesday', 'document', null],
    ['', 'pdf', null],
  ])('%s (%s) → %s', (name, kind, type) => {
    expect(ruleDocType(name, kind)).toBe(type);
  });
});

describe('VTID-04822 gate', () => {
  test('off (default, typo), no tenant or no documents: nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_DOCUMENT_TYPE_ROUTING_MODE: 'yes' }] as NodeJS.ProcessEnv[]) {
      expect(isDocumentTypeRoutingOn(env)).toBe(false);
      expect(await runDocumentTypeRouting({ docs: [doc('a', 'NDA')], tenantId: TENANT, env, sb, decideOptions: { call } })).toEqual([]);
    }
    expect(await runDocumentTypeRouting({ docs: [doc('a', 'NDA')], tenantId: null, env: SHADOW, sb, decideOptions: { call } })).toEqual([]);
    expect(await runDocumentTypeRouting({ docs: [], tenantId: TENANT, env: SHADOW, sb, decideOptions: { call } })).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  test('top three non-folder documents; agreement where the rule names a type, open where it does not', async () => {
    const call = jest.fn()
      .mockResolvedValueOnce(answer('contract'))
      .mockResolvedValueOnce(answer('contract'))
      .mockResolvedValueOnce(answer('report'));
    const docs = [doc('f', 'Contracts', 'folder', 'microsoft'), doc('a', 'NDA Acme'), doc('b', 'Rechnung 42'), doc('c', 'Notes from Tuesday'), doc('d', 'Q3 Bericht')];
    expect(await runDocumentTypeRouting({ docs, tenantId: TENANT, env: SHADOW, sb, decideOptions: { call } })).toEqual(['s1', 's2', 's3']);
    expect(call).toHaveBeenCalledTimes(3);
    expect(rows.map((r) => [r.subject_ref, r.system_action, r.jev_verdict.type, r.jev_verdict.route, r.agreed])).toEqual([
      ['google:a', 'rule_contract', 'contract', 'clause_review', true],
      ['google:b', 'rule_invoice', 'contract', 'clause_review', false],
      ['google:c', 'rule_none', 'report', 'none', null],
    ]);
    expect(rows[0]).toMatchObject({ gate: 'document_type_routing', decision: 'document_type', tenant_id: TENANT, subject_type: 'company_document', outcome: 'compared_with_name_rule' });
    expect(rows[2]).toMatchObject({ outcome: null, outcome_at: null });
  });

  test('a document typed in the last month is not asked again', async () => {
    seen['google:a'] = true;
    const call = jest.fn().mockResolvedValue(answer('invoice'));
    await runDocumentTypeRouting({ docs: [doc('a', 'NDA'), doc('b', 'Rechnung')], tenantId: TENANT, env: SHADOW, sb, decideOptions: { call } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.subject_ref)).toEqual(['google:b']);
  });

  test('Jev down → fallback row; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runDocumentTypeRouting({ docs: [doc('a', 'NDA')], tenantId: TENANT, env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0, jev_verdict: { rule_type: 'contract' } });
    await expect(runDocumentTypeRouting({ docs: [null as any], tenantId: TENANT, env: SHADOW, sb })).resolves.toEqual([]);
  });
});

describe('VTID-04822 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('runs after a company document search with results, never awaited', () => {
    const op = fs.readFileSync(path.join(__dirname, '../src/services/gemini-operator.ts'), 'utf8');
    const fn = op.slice(op.indexOf('export async function executeCompanyDocsTool('), op.indexOf('export async function executeTool('));
    expect(fn).toContain('if (isDocumentTypeRoutingOn()) void runDocumentTypeRouting({ docs: found, tenantId });');
    expect(fn.indexOf('runDocumentTypeRouting')).toBeGreaterThan(fn.indexOf('if (found.length) {'));
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_DOCUMENT_TYPE_ROUTING_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_DOCUMENT_TYPE_ROUTING_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_DOCUMENT_TYPE_ROUTING_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
