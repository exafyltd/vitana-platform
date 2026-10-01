/**
 * VTID-04820: Jev P3 gate E10 — partner onboarding triage on submit
 * (advisory). Shadow only; the submit is unchanged.
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
import { isPartnerTriageOn, runPartnerTriage, triageInput, type TriageOrg, type TriageStep } from '../src/services/jev/gates/partner-triage-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_PARTNER_ONBOARDING_TRIAGE_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const TENANT = '11111111-1111-4111-8111-111111111111';

const ORG: TriageOrg = { id: 'org-1', partner_type: 'merchant', commerce_vertical: 'supplements', legal_name: 'Vital Labs GmbH', country: 'de', vat_id: 'DE123456789', website: 'vital-labs.de/shop' };
const STEPS: TriageStep[] = [
  { key: 'company', required: true, status: 'done' },
  { key: 'verification', required: true, status: 'failed', missing: ['domain_proof'] },
  { key: 'terms', required: true, status: 'done' },
];

function answer(ready: number, concern = 'verification_gap') {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { ready: { type: 'noul', noul: ready }, concern: { type: 'choice', choice: concern, probabilities: { [concern]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 200, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04820 decision and input', () => {
  test('partner_onboarding_triage: business data, internal plane, redacted, ready + concern', () => {
    const d = getJevDecision('partner_onboarding_triage')!;
    expect(d.data).toBe('business');
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal']);
    expect(Object.keys(d.questions)).toEqual(['ready', 'concern']);
  });
  test('business facts and the checklist; the VAT number itself never leaves, only whether one exists', () => {
    const i = triageInput(ORG, STEPS, 2, 'needs_action');
    expect(i).toEqual({
      partner_type: 'merchant', commerce_vertical: 'supplements', legal_name: 'Vital Labs GmbH', country: 'DE', website_host: 'vital-labs.de',
      has_vat_id: true, verification_level_required: 2,
      steps: [
        { key: 'company', required: true, status: 'done', missing: [] },
        { key: 'verification', required: true, status: 'failed', missing: ['domain_proof'] },
        { key: 'terms', required: true, status: 'done', missing: [] },
      ],
      rules_outcome: 'needs_action',
    });
    expect(JSON.stringify(i)).not.toContain('DE123456789');
    expect(triageInput({ ...ORG, website: 'not a url ::', vat_id: '  ', partner_type: null }, [], 9, 'live')).toMatchObject({ website_host: undefined, has_vat_id: false, partner_type: 'unknown', verification_level_required: 2 });
  });
});

describe('VTID-04820 gate', () => {
  test('off (default, typo) or no tenant: nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_PARTNER_ONBOARDING_TRIAGE_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isPartnerTriageOn(env)).toBe(false);
      expect(await runPartnerTriage({ org: ORG, tenantId: TENANT, steps: STEPS, verificationLevel: 2, rulesOutcome: 'needs_action', env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(await runPartnerTriage({ org: ORG, tenantId: null, steps: STEPS, verificationLevel: 2, rulesOutcome: 'live', env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test.each([
    ['needs_action', 0.1, true],
    ['needs_action', 0.9, false],
    ['live', 0.9, true],
    ['live', 0.1, false],
  ])('rules %s, Jev ready p=%s → agreed %s', async (rules, p, agreed) => {
    expect(await runPartnerTriage({ org: ORG, tenantId: TENANT, steps: STEPS, verificationLevel: 2, rulesOutcome: rules as any, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(p as number)) } })).toBe('s1');
    expect(rows[0]).toMatchObject({
      gate: 'partner_onboarding_triage', decision: 'partner_onboarding_triage', tenant_id: TENANT, subject_type: 'partner_organization', subject_ref: 'org-1',
      system_action: `submit_${rules}`, jev_verdict: { rules_outcome: rules, partner_type: 'merchant', concern: 'verification_gap' }, agreed,
    });
  });

  test('abstained → agreed null; Jev down → fallback row; never throws', async () => {
    await runPartnerTriage({ org: ORG, tenantId: TENANT, steps: STEPS, verificationLevel: 2, rulesOutcome: 'live', env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(0.5)) } });
    expect(rows[0]).toMatchObject({ agreed: null, outcome: null });
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runPartnerTriage({ org: ORG, tenantId: TENANT, steps: STEPS, verificationLevel: 2, rulesOutcome: 'live', env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[1]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0 });
    await expect(runPartnerTriage({ org: null as any, tenantId: TENANT, steps: STEPS, verificationLevel: 2, rulesOutcome: 'live', env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04820 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('after submit\'s state moves, before the response, never awaited', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/partner-onboarding.ts'), 'utf8');
    const at = src.indexOf('void runPartnerTriage({ org, tenantId: (req as AuthenticatedRequest).identity?.tenant_id ?? null, steps: checklist.steps, verificationLevel: checklist.verification_level_required, rulesOutcome: verdict.outcome });');
    expect(at).toBeGreaterThan(src.indexOf("reason: 'submit',"));
    expect(at).toBeLessThan(src.lastIndexOf('return respondWithState(res, supabase, orgId, 200, {'));
    expect(src).toContain('if (applied.length && isPartnerTriageOn()) {');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_PARTNER_ONBOARDING_TRIAGE_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_PARTNER_ONBOARDING_TRIAGE_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_PARTNER_ONBOARDING_TRIAGE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
