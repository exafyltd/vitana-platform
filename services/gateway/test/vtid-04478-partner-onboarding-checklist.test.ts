/**
 * VTID-04478 — onboarding checklist and engine decision (spec §6.1, §5.2, §7).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { canTransition, PARTNER_TYPES } from '../src/services/partner-lifecycle';
import {
  DERIVED_STEPS,
  STEP_KEYS,
  buildChecklist,
  evaluateVerification,
  requiredSteps,
  submitTransitions,
  type ChecklistInput,
} from '../src/services/partner-onboarding-checklist';

const MIGRATION = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260924150000_vtid_04478_partner_onboarding_engine.sql'),
  'utf8',
);

function input(over: Partial<ChecklistInput> = {}, org: Partial<ChecklistInput['org']> = {}): ChecklistInput {
  return {
    org: { partner_type: 'supplier_shop', legal_name: null, country: null, vat_id: null, website: null, ...org },
    storedSteps: [],
    acceptedTermsVersions: [],
    currentTermsVersion: '2026-09',
    memberCount: 1,
    catalogueSource: { connections: 0, completeOfferings: 0 },
    ...over,
  };
}

const COMPLETE_SHOP_COMPANY = { legal_name: 'Acme GmbH', country: 'DE', vat_id: 'DE123456789', website: 'https://acme.example/' };

describe('required steps per partner type (spec §6.1)', () => {
  it('matches the spec table', () => {
    expect(requiredSteps('lab')).toEqual(['account', 'company', 'verification', 'catalogue', 'mapping', 'results_channel', 'terms', 'dpa']);
    expect(requiredSteps('supplier_shop')).toContain('tracking_test');
    expect(requiredSteps('supplier_shop')).toContain('billing_mandate');
    expect(requiredSteps('practitioner_clinic')).toContain('dpa');
    expect(requiredSteps('practitioner_clinic')).not.toContain('tracking_test');
    expect(requiredSteps('affiliate_brand')).not.toContain('billing_mandate');
  });

  it('never requires the optional team step', () => {
    for (const t of PARTNER_TYPES) expect(requiredSteps(t)).not.toContain('team');
  });
});

describe('buildChecklist', () => {
  it('starts a new shop at the company step, not ready to submit', () => {
    const c = buildChecklist(input());
    expect(c.steps.find((s) => s.key === 'account')!.status).toBe('done');
    expect(c.next_step).toBe('company');
    expect(c.submit_ready).toBe(false);
    expect(c.submit_missing).toEqual(['company', 'terms']);
    expect(c.verification_level_required).toBe(1);
  });

  it('names the missing company facts and needs a VAT id only inside the EU', () => {
    const partial = buildChecklist(input({}, { legal_name: 'Acme', country: 'DE', website: 'https://a.example/' }));
    const company = partial.steps.find((s) => s.key === 'company')!;
    expect(company.status).toBe('in_progress');
    expect(company.missing).toEqual(['vat_id']);

    const outsideEu = buildChecklist(input({}, { legal_name: 'Acme', country: 'CH', website: 'https://a.example/' }));
    expect(outsideEu.steps.find((s) => s.key === 'company')!.status).toBe('done');
  });

  it('marks terms done only for the version in force', () => {
    const old = buildChecklist(input({ acceptedTermsVersions: ['2026-01'] }));
    expect(old.steps.find((s) => s.key === 'terms')!.status).toBe('todo');
    const current = buildChecklist(input({ acceptedTermsVersions: ['2026-09'] }));
    expect(current.steps.find((s) => s.key === 'terms')!.status).toBe('done');
    const unpublished = buildChecklist(input({ currentTermsVersion: null, acceptedTermsVersions: ['2026-09'] }));
    expect(unpublished.steps.find((s) => s.key === 'terms')!).toMatchObject({ status: 'todo', missing: ['terms_not_published'] });
    // VTID-04895: an earlier version sharing the current baseline (editorial update) counts; another baseline does not.
    const editorial = buildChecklist(input({ acceptedTermsVersions: ['2026-08'], termsBaselineVersions: ['2026-08', '2026-09'] }));
    expect(editorial.steps.find((s) => s.key === 'terms')!.status).toBe('done');
    const material = buildChecklist(input({ acceptedTermsVersions: ['2026-01'], termsBaselineVersions: ['2026-09'] }));
    expect(material.steps.find((s) => s.key === 'terms')!).toMatchObject({ status: 'todo', detail: { current_version: '2026-09' } });
  });

  it('reads stored rows only for non-derived steps', () => {
    const c = buildChecklist(input({
      storedSteps: [
        { step_key: 'catalogue', status: 'done' },
        { step_key: 'verification', status: 'failed', detail: { reason: 'vat_invalid' } },
        { step_key: 'company', status: 'done' },
        { step_key: 'tracking_test', status: 'nonsense' },
      ],
    }));
    expect(c.steps.find((s) => s.key === 'catalogue')!.status).toBe('done');
    expect(c.steps.find((s) => s.key === 'verification')!).toMatchObject({ status: 'failed', detail: { reason: 'vat_invalid' } });
    expect(c.steps.find((s) => s.key === 'company')!.status).toBe('todo');
    expect(c.steps.find((s) => s.key === 'tracking_test')!.status).toBe('todo');
  });

  it('marks steps a type does not need as not_required, and team from the member count', () => {
    const c = buildChecklist(input({ memberCount: 3 }, { partner_type: 'affiliate_brand' }));
    expect(c.steps.find((s) => s.key === 'dpa')!.status).toBe('not_required');
    expect(c.steps.find((s) => s.key === 'billing_mandate')!.status).toBe('not_required');
    expect(c.steps.find((s) => s.key === 'team')!).toMatchObject({ required: false, status: 'done' });
  });

  it('is complete only when every required step is done', () => {
    const all = requiredSteps('affiliate_brand')
      .filter((k) => !DERIVED_STEPS.includes(k))
      .map((k) => ({ step_key: k, status: 'done' }));
    // A connected partner: the stored mapping row (connections reconcile) counts.
    const c = buildChecklist(input(
      { storedSteps: all, acceptedTermsVersions: ['2026-09'], catalogueSource: { connections: 1, completeOfferings: 0 } },
      { partner_type: 'affiliate_brand', ...COMPLETE_SHOP_COMPANY },
    ));
    expect(c.complete).toBe(true);
    expect(c.next_step).toBeNull();
    expect(evaluateVerification(c).outcome).toBe('live');
  });
});

describe('engine decision', () => {
  it('sends a submitted org with open steps to needs_action and names them', () => {
    const c = buildChecklist(input(
      { acceptedTermsVersions: ['2026-09'], storedSteps: [{ step_key: 'verification', status: 'failed' }] },
      COMPLETE_SHOP_COMPANY,
    ));
    expect(c.submit_ready).toBe(true);
    const v = evaluateVerification(c);
    expect(v.outcome).toBe('needs_action');
    expect(v.open_steps).toEqual(['verification', 'catalogue', 'mapping', 'tracking_test', 'billing_mandate']);
    expect(v.failed_steps).toEqual(['verification']);
  });

  it('plans only allowed transitions, and nothing from other states', () => {
    for (const verdict of ['live', 'needs_action'] as const) {
      for (const from of ['draft', 'needs_action'] as const) {
        const moves = submitTransitions(from, verdict)!;
        expect(moves[0].from).toBe(from);
        expect(moves[moves.length - 1].to).toBe(verdict);
        for (const m of moves) expect(canTransition(m.from, m.to)).toBe(true);
      }
    }
    for (const from of ['submitted', 'verifying', 'live', 'paused', 'suspended', 'rejected', 'exception'] as const) {
      expect(submitTransitions(from, 'live')).toBeNull();
    }
  });
});

describe('parity with the migration', () => {
  it('stores exactly the non-derived steps (plus the legacy dpa value, VTID-05090)', () => {
    const m = MIGRATION.match(/step_key TEXT NOT NULL CHECK \(step_key IN \(([^)]*)\)/)!;
    const stored = m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
    // VTID-05090: dpa is derived from partner_dpa_signatures now. The CHECK
    // still allows a 'dpa' row (nothing altered or deleted); the engine ignores it.
    expect(stored).toEqual(STEP_KEYS.filter((k) => !DERIVED_STEPS.includes(k) || k === 'dpa'));
    expect(DERIVED_STEPS).toContain('dpa');
  });
});

describe('VTID-05090 — the dpa step is derived from DPA signatures', () => {
  const LAB_COMPANY = { legal_name: 'Labor GmbH', country: 'DE', vat_id: 'DE123456789', website: 'https://lab.example/' };
  const labDone = (over: Partial<ChecklistInput> = {}) =>
    input(
      {
        acceptedTermsVersions: ['2026-09'],
        storedSteps: ['verification', 'catalogue', 'mapping', 'results_channel'].map((k) => ({ step_key: k, status: 'done' })),
        catalogueSource: { connections: 1, completeOfferings: 0 },
        ...over,
      },
      { partner_type: 'lab', ...LAB_COMPANY },
    );
  const dpa = (c: ReturnType<typeof buildChecklist>) => c.steps.find((s) => s.key === 'dpa')!;

  it('a lab with no DPA version published: todo with dpa_not_published, never complete or live', () => {
    const c = buildChecklist(labDone());
    expect(dpa(c)).toEqual({ key: 'dpa', required: true, status: 'todo', missing: ['dpa_not_published'] });
    expect(c.complete).toBe(false);
    expect(c.next_step).toBe('dpa');
    expect(evaluateVerification(c)).toMatchObject({ outcome: 'needs_action', open_steps: ['dpa'] });
  });

  it('signed under the current version → done, and a finished lab goes live', () => {
    const c = buildChecklist(labDone({ currentDpaVersion: 'avv-1', signedDpaVersions: ['avv-1'] }));
    expect(dpa(c).status).toBe('done');
    expect(c.complete).toBe(true);
    expect(evaluateVerification(c).outcome).toBe('live');
  });

  it('published but unsigned → todo naming the current version', () => {
    expect(dpa(buildChecklist(labDone({ currentDpaVersion: 'avv-1' })))).toMatchObject({ status: 'todo', detail: { current_version: 'avv-1' } });
  });

  it('an editorial update keeps the signature; a material one (new baseline) reopens the step', () => {
    const editorial = buildChecklist(labDone({ currentDpaVersion: 'avv-2', dpaBaselineVersions: ['avv-1', 'avv-2'], signedDpaVersions: ['avv-1'] }));
    expect(dpa(editorial).status).toBe('done');
    const material = buildChecklist(labDone({ currentDpaVersion: 'avv-2', dpaBaselineVersions: ['avv-2'], signedDpaVersions: ['avv-1'] }));
    expect(dpa(material)).toMatchObject({ status: 'todo', detail: { current_version: 'avv-2' } });
    expect(evaluateVerification(material).outcome).toBe('needs_action');
  });

  it('a stored dpa row no longer overrides the derived status', () => {
    const c = buildChecklist(labDone({ storedSteps: [{ step_key: 'dpa', status: 'done' }] }));
    expect(dpa(c)).toMatchObject({ status: 'todo', missing: ['dpa_not_published'] });
  });

  it('practitioner_clinic needs it too; a service provider does not (not_required, no missing code)', () => {
    const clinic = buildChecklist(input({}, { partner_type: 'practitioner_clinic' }));
    expect(dpa(clinic)).toMatchObject({ required: true, status: 'todo', missing: ['dpa_not_published'] });
    const sp = buildChecklist(input({ currentDpaVersion: null }, { partner_type: 'service_provider' }));
    expect(dpa(sp)).toEqual({ key: 'dpa', required: false, status: 'not_required' });
  });
});
