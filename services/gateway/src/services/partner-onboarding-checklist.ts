/**
 * VTID-04478 — the partner onboarding checklist and the engine's decision
 * (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.1, §6.2, §7).
 *
 * Pure functions only. The route reads the org, its stored step rows and its
 * terms acceptances, hands them here, and applies whatever lifecycle moves
 * `decideAfterSubmit` returns, one guarded transition at a time.
 *
 * Step status comes from one of three places:
 *   - derived from facts the engine can see (account, company, terms, team);
 *   - a row in partner_onboarding_steps, written by the step's own endpoint
 *     (verification, catalogue, mapping, tracking test, results channel,
 *     DPA, billing mandate — each lands with its own VTID);
 *   - otherwise `todo`.
 * A step that is not required for the partner type is `not_required`.
 */

import type { LifecycleState, PartnerType } from './partner-lifecycle';

export const STEP_KEYS = [
  'account',
  'company',
  'verification',
  'catalogue',
  'mapping',
  'tracking_test',
  'results_channel',
  'terms',
  'dpa',
  'billing_mandate',
  'team',
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export const STEP_STATUSES = ['todo', 'in_progress', 'done', 'failed', 'not_required'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Steps the engine can decide itself; a stored row never overrides them. */
export const DERIVED_STEPS: readonly StepKey[] = ['account', 'company', 'terms', 'team'];

/**
 * Spec §6.1. `team` is optional for every type. `billing_mandate` is required
 * for direct shops and service providers; network-sourced partners are
 * affiliate brands, for which it is not required.
 */
const REQUIRED_BY_TYPE: Readonly<Record<PartnerType, readonly StepKey[]>> = {
  lab: ['account', 'company', 'verification', 'catalogue', 'mapping', 'results_channel', 'terms', 'dpa'],
  supplier_shop: ['account', 'company', 'verification', 'catalogue', 'mapping', 'tracking_test', 'terms', 'billing_mandate'],
  practitioner_clinic: ['account', 'company', 'verification', 'catalogue', 'mapping', 'terms', 'dpa'],
  service_provider: ['account', 'company', 'verification', 'catalogue', 'mapping', 'tracking_test', 'terms', 'billing_mandate'],
  affiliate_brand: ['account', 'company', 'verification', 'catalogue', 'mapping', 'tracking_test', 'terms'],
};

/** Spec §7: the verification level each partner type must reach. */
export const VERIFICATION_LEVEL_REQUIRED: Readonly<Record<PartnerType, 0 | 1 | 2>> = {
  lab: 2,
  supplier_shop: 1,
  practitioner_clinic: 2,
  service_provider: 1,
  affiliate_brand: 0,
};

/** The steps a partner must finish before `submit` is accepted. */
export const SUBMIT_PREREQUISITES: readonly StepKey[] = ['account', 'company', 'terms'];

/** EU member states: the company step needs a VAT id for these. */
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export function requiredSteps(type: PartnerType): readonly StepKey[] {
  return REQUIRED_BY_TYPE[type];
}

export interface ChecklistOrg {
  partner_type: PartnerType;
  legal_name: string | null;
  country: string | null;
  vat_id: string | null;
  website: string | null;
}

export interface StoredStep {
  step_key: string;
  status: string;
  detail?: Record<string, unknown> | null;
  updated_at?: string | null;
}

export interface ChecklistInput {
  org: ChecklistOrg;
  storedSteps: StoredStep[];
  /** Versions of the partner terms this org has accepted. */
  acceptedTermsVersions: string[];
  /** The terms version currently in force, or null when none is published. */
  currentTermsVersion: string | null;
  memberCount: number;
}

export interface ChecklistStep {
  key: StepKey;
  required: boolean;
  status: StepStatus;
  /** What is missing, as machine-readable codes the client translates. */
  missing?: string[];
  detail?: Record<string, unknown>;
}

export interface Checklist {
  steps: ChecklistStep[];
  next_step: StepKey | null;
  verification_level_required: 0 | 1 | 2;
  submit_ready: boolean;
  submit_missing: StepKey[];
  complete: boolean;
}

function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value);
}

function companyStatus(org: ChecklistOrg): { status: StepStatus; missing: string[] } {
  const missing: string[] = [];
  if (!org.legal_name) missing.push('legal_name');
  if (!org.country) missing.push('country');
  if (!org.website) missing.push('website');
  if (org.country && EU_COUNTRIES.has(org.country) && !org.vat_id) missing.push('vat_id');
  if (missing.length === 0) return { status: 'done', missing };
  const anySet = Boolean(org.legal_name || org.country || org.website || org.vat_id);
  return { status: anySet ? 'in_progress' : 'todo', missing };
}

export function buildChecklist(input: ChecklistInput): Checklist {
  const required = new Set(requiredSteps(input.org.partner_type));
  const stored = new Map<string, StoredStep>();
  for (const row of input.storedSteps) stored.set(row.step_key, row);

  const steps: ChecklistStep[] = STEP_KEYS.map((key) => {
    const isRequired = required.has(key);
    let status: StepStatus = 'todo';
    let missing: string[] | undefined;
    let detail: Record<string, unknown> | undefined;

    switch (key) {
      case 'account':
        // An org only exists once an authenticated user with an email created
        // it (POST /start refuses a caller without one).
        status = 'done';
        break;
      case 'company': {
        const c = companyStatus(input.org);
        status = c.status;
        if (c.missing.length) missing = c.missing;
        break;
      }
      case 'terms':
        if (!input.currentTermsVersion) {
          status = 'todo';
          missing = ['terms_not_published'];
        } else if (input.acceptedTermsVersions.includes(input.currentTermsVersion)) {
          status = 'done';
        } else {
          status = 'todo';
          detail = { current_version: input.currentTermsVersion };
        }
        break;
      case 'team':
        status = input.memberCount > 1 ? 'done' : 'todo';
        break;
      default: {
        const row = stored.get(key);
        if (row && isStepStatus(row.status)) {
          status = row.status;
          if (row.detail && typeof row.detail === 'object') detail = row.detail;
        }
      }
    }

    if (!isRequired && key !== 'team' && status === 'todo') status = 'not_required';
    const step: ChecklistStep = { key, required: isRequired, status };
    if (missing) step.missing = missing;
    if (detail) step.detail = detail;
    return step;
  });

  const requiredOpen = steps.filter((s) => s.required && s.status !== 'done');
  const submitMissing = SUBMIT_PREREQUISITES.filter(
    (k) => steps.find((s) => s.key === k)?.status !== 'done',
  );

  return {
    steps,
    next_step: requiredOpen.length ? requiredOpen[0].key : null,
    verification_level_required: VERIFICATION_LEVEL_REQUIRED[input.org.partner_type],
    submit_ready: submitMissing.length === 0,
    submit_missing: submitMissing,
    complete: requiredOpen.length === 0,
  };
}

/**
 * The engine's verdict once an org is under verification (spec §5.2, §7):
 * every required step done → live; anything else → needs_action, with the
 * open steps named so the partner knows exactly what to fix. Nothing here
 * produces `exception` yet — that needs a check whose failure the partner
 * cannot fix (§10), and none of those checks exist in this VTID.
 */
export function evaluateVerification(checklist: Checklist): {
  outcome: 'live' | 'needs_action';
  open_steps: StepKey[];
  failed_steps: StepKey[];
} {
  const open = checklist.steps.filter((s) => s.required && s.status !== 'done');
  return {
    outcome: open.length === 0 ? 'live' : 'needs_action',
    open_steps: open.map((s) => s.key),
    failed_steps: open.filter((s) => s.status === 'failed').map((s) => s.key),
  };
}

/**
 * The ordered lifecycle moves `submit` makes from the org's current state.
 * Every pair is a transition `canTransition` allows; the route applies them
 * one at a time, each guarded on the state it expects to leave.
 */
export function submitTransitions(
  from: LifecycleState,
  verdict: 'live' | 'needs_action',
): Array<{ from: LifecycleState; to: LifecycleState }> | null {
  if (from === 'draft') {
    return [
      { from: 'draft', to: 'submitted' },
      { from: 'submitted', to: 'verifying' },
      { from: 'verifying', to: verdict },
    ];
  }
  if (from === 'needs_action') {
    return [
      { from: 'needs_action', to: 'verifying' },
      { from: 'verifying', to: verdict },
    ];
  }
  return null;
}
