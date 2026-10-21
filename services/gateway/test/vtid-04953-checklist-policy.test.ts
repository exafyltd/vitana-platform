/**
 * VTID-04953 — Commerce checklist policy v1 (owner decisions B3/B4, 2026-10-07).
 *
 * B4: service providers do not need tracking_test or billing_mandate until
 * those systems exist; every other type keeps its rules.
 * B3: with no external catalogue connection, mapping is complete once there is
 * one complete offering; with a connection, the connections reconcile's
 * stored row stays the source of truth.
 */
import {
  buildChecklist,
  evaluateVerification,
  isCompleteOffering,
  requiredSteps,
  type ChecklistInput,
} from '../src/services/partner-onboarding-checklist';

const COMPANY = { legal_name: 'EXAFY LTD', country: 'AE', vat_id: null, website: 'https://www.exafy.io/' };

function input(over: Partial<ChecklistInput> = {}, org: Partial<ChecklistInput['org']> = {}): ChecklistInput {
  return {
    org: { partner_type: 'service_provider', ...COMPANY, ...org },
    storedSteps: [],
    acceptedTermsVersions: ['2026-10'],
    currentTermsVersion: '2026-10',
    memberCount: 1,
    catalogueSource: { connections: 0, completeOfferings: 0 },
    ...over,
  };
}

const step = (c: ReturnType<typeof buildChecklist>, k: string) => c.steps.find((s) => s.key === k)!;

const COMPLETE = {
  title: 'AI & Digital Platform Consultation',
  price_cents: 15000,
  currency: 'EUR',
  affiliate_url: 'https://www.exafy.io/',
  origin_country: 'AE',
  ships_to_countries: ['AE'],
};

describe('B4 — service provider requirements', () => {
  it('drops tracking_test and billing_mandate for service providers only', () => {
    expect(requiredSteps('service_provider')).toEqual(['account', 'company', 'verification', 'catalogue', 'mapping', 'terms']);
    expect(requiredSteps('supplier_shop')).toEqual(expect.arrayContaining(['tracking_test', 'billing_mandate']));
    expect(requiredSteps('affiliate_brand')).toContain('tracking_test');
    expect(requiredSteps('lab')).toEqual(['account', 'company', 'verification', 'catalogue', 'mapping', 'results_channel', 'terms', 'dpa']);
    expect(requiredSteps('practitioner_clinic')).toEqual(['account', 'company', 'verification', 'catalogue', 'mapping', 'terms', 'dpa']);
  });

  it('shows them as not_required on a service provider checklist', () => {
    const c = buildChecklist(input());
    expect(step(c, 'tracking_test')).toMatchObject({ required: false, status: 'not_required' });
    expect(step(c, 'billing_mandate')).toMatchObject({ required: false, status: 'not_required' });
  });
});

describe('B3 — mapping without an external catalogue connection', () => {
  it('is done with one complete offering, todo without one', () => {
    const done = buildChecklist(input({ catalogueSource: { connections: 0, completeOfferings: 1 } }));
    expect(step(done, 'mapping')).toMatchObject({ required: true, status: 'done', detail: { source: 'catalogue', complete_offerings: 1 } });
    const todo = buildChecklist(input());
    expect(step(todo, 'mapping')).toMatchObject({ status: 'todo', missing: ['complete_offering'], detail: { source: 'catalogue', complete_offerings: 0 } });
  });

  it('ignores a stale stored mapping row when there is no connection', () => {
    const c = buildChecklist(input({ storedSteps: [{ step_key: 'mapping', status: 'done' }] }));
    expect(step(c, 'mapping').status).toBe('todo');
  });

  it('keeps the stored row as the source of truth when a connection exists', () => {
    const inProgress = buildChecklist(input({
      catalogueSource: { connections: 1, completeOfferings: 3 },
      storedSteps: [{ step_key: 'mapping', status: 'in_progress', detail: { source: 'connections' } }],
    }));
    expect(step(inProgress, 'mapping')).toMatchObject({ status: 'in_progress', detail: { source: 'connections' } });
    const done = buildChecklist(input({
      catalogueSource: { connections: 1, completeOfferings: 0 },
      storedSteps: [{ step_key: 'mapping', status: 'done' }],
    }));
    expect(step(done, 'mapping').status).toBe('done');
    const none = buildChecklist(input({ catalogueSource: { connections: 1, completeOfferings: 5 } }));
    expect(step(none, 'mapping').status).toBe('todo');
  });

  it('a service provider with verification, a catalogue and one complete offering is complete', () => {
    const c = buildChecklist(input({
      catalogueSource: { connections: 0, completeOfferings: 1 },
      storedSteps: [
        { step_key: 'verification', status: 'done' },
        { step_key: 'catalogue', status: 'done' },
      ],
    }));
    expect(c.complete).toBe(true);
    expect(evaluateVerification(c)).toMatchObject({ outcome: 'live', open_steps: [] });
  });

  it('without verification only verification stays open (the EXAFY case before approval)', () => {
    const c = buildChecklist(input({
      catalogueSource: { connections: 0, completeOfferings: 1 },
      storedSteps: [{ step_key: 'catalogue', status: 'done' }],
    }));
    expect(evaluateVerification(c).open_steps).toEqual(['verification']);
  });
});

describe('isCompleteOffering', () => {
  it('accepts every field ProductSchema requires, listed or not', () => {
    expect(isCompleteOffering(COMPLETE)).toBe(true);
    expect(isCompleteOffering({ ...COMPLETE, ships_to_countries: [], ships_to_regions: ['EU'] })).toBe(true);
    expect(isCompleteOffering({ ...COMPLETE, price_cents: 0 })).toBe(true);
  });

  it.each([
    ['no title', { title: '  ' }],
    ['no price', { price_cents: null }],
    ['bad currency', { currency: 'EURO' }],
    ['no link', { affiliate_url: null }],
    ['no origin country', { origin_country: null }],
    ['ships nowhere', { ships_to_countries: [], ships_to_regions: [] }],
  ])('rejects an offering with %s', (_label, patch) => {
    expect(isCompleteOffering({ ...COMPLETE, ...patch } as any)).toBe(false);
  });
});
