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
    const c = buildChecklist(input(
      { storedSteps: all, acceptedTermsVersions: ['2026-09'] },
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
  it('stores exactly the non-derived steps', () => {
    const m = MIGRATION.match(/step_key TEXT NOT NULL CHECK \(step_key IN \(([^)]*)\)/)!;
    const stored = m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(stored).toEqual(STEP_KEYS.filter((k) => !DERIVED_STEPS.includes(k)));
  });
});
