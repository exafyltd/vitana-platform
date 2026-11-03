/**
 * VTID-05238 — every open onboarding step says who can finish it: the
 * supplier's AI assistant, the supplier themselves, or Vitanaland.
 *
 * Contract:
 *   - `stepOwner` is pure: null for a done/not_required/not-required step;
 *     company/catalogue/mapping → assistant; terms/dpa/billing_mandate/
 *     results_channel/tracking_test/team/account → supplier; verification
 *     follows its open codes (facts_changed → assistant, review_note →
 *     supplier, supplier codes → supplier, assistant codes incl. `website`
 *     → assistant, Vitanaland-only codes → vitanaland, unknown → supplier).
 *   - A stale verification keeps the stored row's detail, so detail.missing
 *     holds old codes; facts_changed in `missing` wins and ignores them (R1-F1).
 *   - `buildChecklist` adds only `owner` on open required steps and changes
 *     nothing else.
 *   - The Commerce MCP status carries `owner` on open steps and on
 *     `next_action`; done_on_vitanaland/link/tool/supplier_action are byte for
 *     byte; `ON_SCREEN_STEPS` is exactly the five supplier-action keys (R2-F1).
 */

import {
  buildChecklist,
  stepOwner,
  type ChecklistInput,
  type ChecklistStep,
  type StepKey,
} from '../src/services/partner-onboarding-checklist';
import { ON_SCREEN_STEPS, nextAction, shapeStatus } from '../src/services/commerce-mcp';

// A minimal open required step for the owner table.
const step = (over: Partial<ChecklistStep> & { key: StepKey }): ChecklistStep => ({
  required: true,
  status: 'todo',
  ...over,
});

describe('stepOwner — null cases', () => {
  it('a done step has no owner', () => {
    expect(stepOwner(step({ key: 'company', status: 'done' }))).toBeNull();
  });
  it('a not_required step has no owner', () => {
    expect(stepOwner(step({ key: 'dpa', status: 'not_required' }))).toBeNull();
  });
  it('a step not required for the type has no owner', () => {
    expect(stepOwner(step({ key: 'company', required: false }))).toBeNull();
  });
});

describe('stepOwner — fixed owners per step key', () => {
  it.each<[StepKey, string]>([
    ['company', 'assistant'],
    ['catalogue', 'assistant'],
    ['mapping', 'assistant'],
    ['terms', 'supplier'],
    ['dpa', 'supplier'],
    ['billing_mandate', 'supplier'],
    ['results_channel', 'supplier'],
    ['tracking_test', 'supplier'],
    ['team', 'supplier'],
    ['account', 'supplier'],
  ])('%s → %s', (key, owner) => {
    expect(stepOwner(step({ key }))).toBe(owner);
  });

  it('catalogue carrying catalogue_fixes is still the assistant', () => {
    expect(stepOwner(step({ key: 'catalogue', missing: ['catalogue_fixes'], detail: { returned_products: 2 } }))).toBe('assistant');
  });
});

describe('stepOwner — verification, first match wins', () => {
  const v = (over: Partial<ChecklistStep>): ChecklistStep => step({ key: 'verification', ...over });

  it('facts_changed in missing → assistant, ignoring stale detail.missing (R1-F1)', () => {
    // A stale row: missing is ['facts_changed'] but the old detail still names
    // a supplier code. The supplier code must NOT win.
    const owner = stepOwner(v({ status: 'todo', missing: ['facts_changed'], detail: { missing: ['email_not_verified', 'domain_proof'] } }));
    expect(owner).toBe('assistant');
  });

  it('review_note present → supplier', () => {
    expect(stepOwner(v({ detail: { review_note: { reason: 'Please re-upload the licence.' } } }))).toBe('supplier');
  });

  it('review_note wins over an assistant code in detail.missing', () => {
    expect(stepOwner(v({ detail: { review_note: { reason: 'x' }, missing: ['vat_id'] } }))).toBe('supplier');
  });

  it.each([['email_not_verified'], ['domain_proof']])('supplier code %s → supplier', (code) => {
    expect(stepOwner(v({ missing: [code] }))).toBe('supplier');
  });

  it.each([['website'], ['vat_id'], ['vat_invalid'], ['email_check_unavailable'], ['domain_check_unavailable'], ['vat_check_unavailable']])(
    'assistant code %s → assistant',
    (code) => {
      expect(stepOwner(v({ missing: [code] }))).toBe('assistant');
    },
  );

  it('website (R1-F2) in detail.missing → assistant', () => {
    expect(stepOwner(v({ detail: { missing: ['website'] } }))).toBe('assistant');
  });

  it('a supplier code and an assistant code together → supplier (first match wins)', () => {
    expect(stepOwner(v({ missing: ['vat_id', 'email_not_verified'] }))).toBe('supplier');
  });

  it.each([['business_verification_pending'], ['business_verification'], ['licence'], ['licence_missing']])(
    'Vitanaland-only code %s → vitanaland',
    (code) => {
      expect(stepOwner(v({ missing: [code] }))).toBe('vitanaland');
    },
  );

  it('in_progress with no code → vitanaland', () => {
    expect(stepOwner(v({ status: 'in_progress' }))).toBe('vitanaland');
  });

  it('an unknown code → supplier (a new check never silently claims the AI can do it)', () => {
    expect(stepOwner(v({ missing: ['some_new_future_check'] }))).toBe('supplier');
  });

  it('a never-checked verification (todo, no codes) → assistant, not vitanaland (R2-F1)', () => {
    // A required todo/failed verification with no missing and no detail.missing
    // means "run the checks" — the assistant's job, not a Vitanaland review.
    expect(stepOwner(v({ status: 'todo' }))).toBe('assistant');
    expect(stepOwner(v({ status: 'failed' }))).toBe('assistant');
  });

  it('an unknown code alongside an assistant code → supplier (unknown wins, R2-F2)', () => {
    // The unknown-code check runs before the assistant-code match, so a
    // brand-new check never silently claims the AI can do it.
    expect(stepOwner(v({ detail: { missing: ['vat_id', 'some_new_check'] } }))).toBe('supplier');
    expect(stepOwner(v({ missing: ['vat_id', 'some_new_check'] }))).toBe('supplier');
  });

  it('union of step.missing and detail.missing is considered when facts_changed is absent', () => {
    expect(stepOwner(v({ missing: [], detail: { missing: ['vat_id'] } }))).toBe('assistant');
  });
});

// ---- buildChecklist ----

const baseInput = (over: Partial<ChecklistInput> = {}): ChecklistInput => ({
  org: { partner_type: 'supplier_shop', legal_name: null, country: null, vat_id: null, website: null },
  storedSteps: [],
  acceptedTermsVersions: [],
  currentTermsVersion: 'v1',
  memberCount: 1,
  catalogueSource: { connections: 0, completeOfferings: 0 },
  ...over,
});

describe('buildChecklist — owner is additive only', () => {
  it('sets owner on every open required step and nothing else', () => {
    const cl = buildChecklist(baseInput());
    for (const s of cl.steps) {
      const open = s.required && s.status !== 'done' && s.status !== 'not_required';
      if (open) {
        expect(s.owner).toBe(stepOwner(s));
        expect(s.owner).toBeTruthy();
      } else {
        expect(s.owner).toBeUndefined();
      }
    }
  });

  it('changes no field other than owner (compared to a run with owner stripped)', () => {
    const cl = buildChecklist(baseInput());
    // Rebuild the expected shape by stripping owner — every other field equal.
    const stripped = cl.steps.map(({ owner, ...rest }) => rest);
    for (let i = 0; i < cl.steps.length; i++) {
      const { owner, ...rest } = cl.steps[i];
      expect(rest).toEqual(stripped[i]);
    }
    // Checklist envelope untouched.
    expect(cl.steps.map((s) => s.key)).toEqual([
      'account', 'company', 'verification', 'catalogue', 'mapping', 'tracking_test', 'results_channel', 'terms', 'dpa', 'billing_mandate', 'team',
    ]);
  });

  it('a done step (account) carries no owner', () => {
    const cl = buildChecklist(baseInput());
    const account = cl.steps.find((s) => s.key === 'account')!;
    expect(account.status).toBe('done');
    expect(account.owner).toBeUndefined();
  });

  it('a stale verification row → owner assistant, old detail codes ignored (R1-F1 end to end)', () => {
    const cl = buildChecklist(
      baseInput({
        org: { partner_type: 'supplier_shop', legal_name: 'X', country: 'DE', vat_id: 'DE1', website: 'https://new.de' },
        storedSteps: [
          {
            step_key: 'verification',
            status: 'done',
            detail: { facts: { website: 'https://old.de', country: 'DE', vat_id: 'DE1' }, missing: ['email_not_verified'] },
          },
        ],
      }),
    );
    const ver = cl.steps.find((s) => s.key === 'verification')!;
    expect(ver.status).toBe('todo');
    expect(ver.missing).toEqual(['facts_changed']);
    expect(ver.owner).toBe('assistant');
  });

  it('verification with a website missing code → owner assistant (R1-F2)', () => {
    const cl = buildChecklist(
      baseInput({
        org: { partner_type: 'supplier_shop', legal_name: 'X', country: 'DE', vat_id: 'DE1', website: 'https://x.de' },
        storedSteps: [{ step_key: 'verification', status: 'failed', detail: { missing: ['website'] } }],
      }),
    );
    const ver = cl.steps.find((s) => s.key === 'verification')!;
    expect(ver.owner).toBe('assistant');
  });
});

// ---- commerce-mcp: shapeStatus + next_action ----

const PORTAL = 'https://app.example';

function statusBody(over: { org?: Record<string, unknown>; checklist?: any } = {}) {
  const checklist = over.checklist === undefined
    ? {
        next_step: 'company',
        complete: false,
        submit_ready: false,
        submit_missing: ['company'],
        steps: [
          { key: 'company', required: true, status: 'in_progress', missing: ['vat_id'], owner: 'assistant' },
          { key: 'terms', required: true, status: 'todo', owner: 'supplier' },
          { key: 'verification', required: true, status: 'todo', owner: 'vitanaland' },
        ],
      }
    : over.checklist;
  return {
    organization: { id: 'org-1', partner_type: 'supplier_shop', lifecycle_state: 'draft', country: 'DE', website: 'https://x.de', ...over.org },
    checklist,
  };
}

describe('shapeStatus — owner on open steps and byte-for-byte fields', () => {
  it('carries owner on each open step', () => {
    const out = shapeStatus(statusBody(), PORTAL) as any;
    const byKey = Object.fromEntries(out.steps.map((s: any) => [s.step, s]));
    expect(byKey.company.owner).toBe('assistant');
    expect(byKey.terms.owner).toBe('supplier');
    expect(byKey.verification.owner).toBe('vitanaland');
  });

  it('keeps every existing field and only adds owner', () => {
    const out = shapeStatus(statusBody(), PORTAL) as any;
    const terms = out.steps.find((s: any) => s.step === 'terms');
    // terms is in ON_SCREEN_STEPS → done_on_vitanaland + link unchanged.
    expect(terms.done_on_vitanaland).toBe(true);
    expect(terms.link).toBe(`${PORTAL}/commerce?org=org-1`);
    const company = out.steps.find((s: any) => s.step === 'company');
    expect(company.missing).toEqual(['vat_id']);
    expect(company.done_on_vitanaland).toBeUndefined();
  });

  it('a step with no owner (done) carries no owner field', () => {
    const body = statusBody({
      checklist: { next_step: null, complete: true, submit_ready: true, submit_missing: [], steps: [{ key: 'company', required: true, status: 'done' }] },
    });
    const out = shapeStatus(body, PORTAL) as any;
    expect(out.steps[0].owner).toBeUndefined();
  });
});

describe('next_action.owner', () => {
  it('owner of the next_action.step', () => {
    const out = shapeStatus(statusBody(), PORTAL) as any;
    expect(out.next_action.step).toBe('company');
    expect(out.next_action.owner).toBe('assistant');
  });

  it('typeless business_type pseudo-step → assistant', () => {
    const action = nextAction(null, true, 'link');
    expect(action).toEqual({ step: 'business_type', tool: 'update_business', supplier_action: null, link: null, owner: 'assistant' });
  });

  it('checklist complete (submit_for_verification) → assistant', () => {
    const action = nextAction({ next_step: null, complete: true, steps: [] }, false, 'link');
    expect(action.tool).toBe('submit_for_verification');
    expect(action.owner).toBe('assistant');
  });

  it('no step and no tool → null owner', () => {
    const action = nextAction({ next_step: null, complete: false, steps: [] }, false, 'link');
    expect(action).toEqual({ step: null, tool: null, supplier_action: null, link: null, owner: null });
  });

  it('a supplier next step carries owner supplier and keeps supplier_action/link', () => {
    const action = nextAction(
      { next_step: 'terms', complete: false, steps: [{ key: 'terms', required: true, status: 'todo', owner: 'supplier' }] },
      false,
      'LINK',
    );
    expect(action.owner).toBe('supplier');
    expect(action.supplier_action).toBe('Read and accept the Partner Terms on Vitanaland.');
    expect(action.link).toBe('LINK');
  });
});

describe('ON_SCREEN_STEPS / STEP_TOOLS consistency (R2-F1)', () => {
  it('ON_SCREEN_STEPS is exactly the five supplier-action keys — team excluded', () => {
    expect([...ON_SCREEN_STEPS].sort()).toEqual(['billing_mandate', 'dpa', 'results_channel', 'terms', 'tracking_test'].sort());
    expect(ON_SCREEN_STEPS.has('team')).toBe(false);
  });

  it('every ON_SCREEN_STEPS key has fixed owner supplier', () => {
    for (const key of ON_SCREEN_STEPS) {
      expect(stepOwner(step({ key: key as StepKey }))).toBe('supplier');
    }
  });

  it('team keeps today byte-for-byte MCP shape (no done_on_vitanaland)', () => {
    const body = statusBody({
      checklist: {
        next_step: 'team',
        complete: false,
        submit_ready: false,
        submit_missing: ['team'],
        steps: [{ key: 'team', required: true, status: 'todo', owner: 'supplier' }],
      },
    });
    const out = shapeStatus(body, PORTAL) as any;
    const team = out.steps.find((s: any) => s.step === 'team');
    expect(team.done_on_vitanaland).toBeUndefined();
    expect(team.link).toBeUndefined();
    expect(team.owner).toBe('supplier');
  });
});
