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

/**
 * VTID-05238 — who can finish an open step: the supplier's AI assistant
 * (`assistant`), only the supplier themselves (`supplier`), or a Vitanaland
 * admin review (`vitanaland`). A done, not-required or not-required-by-type
 * step has no owner (`stepOwner` returns null).
 */
export type StepOwner = 'assistant' | 'supplier' | 'vitanaland';

/** Steps the engine can decide itself; a stored row never overrides them. */
export const DERIVED_STEPS: readonly StepKey[] = ['account', 'company', 'terms', 'team'];

/**
 * Spec §6.1. `team` is optional for every type. `billing_mandate` is required
 * for direct shops; network-sourced partners are affiliate brands, for which
 * it is not required.
 *
 * VTID-04953 (owner decision B4, 2026-10-07): for service providers v1,
 * `tracking_test` and `billing_mandate` are not required until the tracking
 * and billing systems exist — nobody could complete them. Re-add them here
 * when those systems ship.
 */
const REQUIRED_BY_TYPE: Readonly<Record<PartnerType, readonly StepKey[]>> = {
  lab: ['account', 'company', 'verification', 'catalogue', 'mapping', 'results_channel', 'terms', 'dpa'],
  supplier_shop: ['account', 'company', 'verification', 'catalogue', 'mapping', 'tracking_test', 'terms', 'billing_mandate'],
  practitioner_clinic: ['account', 'company', 'verification', 'catalogue', 'mapping', 'terms', 'dpa'],
  service_provider: ['account', 'company', 'verification', 'catalogue', 'mapping', 'terms'],
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

/** EU member states: the company step needs a VAT id for these, and VIES checks it. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
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
  /**
   * VTID-04895: every version that shares the current version's re-acceptance
   * baseline. Accepting any of them counts (an editorial update keeps earlier
   * acceptances valid). Omitted: only the current version counts.
   */
  termsBaselineVersions?: string[];
  memberCount: number;
  /**
   * VTID-04953 (owner decision B3): where the catalogue comes from. With no
   * external catalogue connection, mapping is derived from complete
   * offerings; with one, the connections reconcile owns the mapping row.
   */
  catalogueSource: {
    connections: number;
    completeOfferings: number;
    /**
     * VTID-05153: products the catalogue check returned to the supplier after
     * three failed checks. Adds `catalogue_fixes` to the catalogue step's
     * `missing`; the step's status is never changed by it.
     */
    returnedProducts?: number;
  };
}

/** The product fields `isCompleteOffering` reads. */
export interface OfferingFields {
  title?: string | null;
  price_cents?: number | null;
  currency?: string | null;
  affiliate_url?: string | null;
  origin_country?: string | null;
  ships_to_countries?: string[] | null;
  ships_to_regions?: string[] | null;
}

/**
 * VTID-04953: a complete offering has every field ProductSchema requires
 * (routes/vcaop-portal-my-products.ts ProductFields + shipsSomewhere).
 * Whether it is listed does not matter — mapping is about catalogue data,
 * and an offering an admin keeps offline still counts.
 */
export function isCompleteOffering(p: OfferingFields): boolean {
  const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  return (
    filled(p.title) &&
    typeof p.price_cents === 'number' &&
    p.price_cents >= 0 &&
    typeof p.currency === 'string' &&
    p.currency.length === 3 &&
    filled(p.affiliate_url) &&
    typeof p.origin_country === 'string' &&
    p.origin_country.length === 2 &&
    ((p.ships_to_countries?.length ?? 0) > 0 || (p.ships_to_regions?.length ?? 0) > 0)
  );
}

export interface ChecklistStep {
  key: StepKey;
  required: boolean;
  status: StepStatus;
  /** What is missing, as machine-readable codes the client translates. */
  missing?: string[];
  detail?: Record<string, unknown>;
  /**
   * VTID-05238: who can finish this step when it is open. Set by
   * `buildChecklist` on every open required step; absent otherwise.
   */
  owner?: StepOwner;
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

/**
 * VTID-04486: the verification step row records the company facts it checked
 * (`detail.facts`). A row without them predates that rule and is not judged.
 */
export function verificationIsStale(detail: Record<string, unknown> | null | undefined, org: ChecklistOrg): boolean {
  const facts = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).facts : undefined;
  if (!facts || typeof facts !== 'object') return false;
  const f = facts as Record<string, unknown>;
  return (
    (f.website ?? null) !== (org.website ?? null) ||
    (f.country ?? null) !== (org.country ?? null) ||
    (f.vat_id ?? null) !== (org.vat_id ?? null)
  );
}

/** VTID-05238: steps whose owner is fixed to the supplier regardless of state. */
const SUPPLIER_STEPS: ReadonlySet<StepKey> = new Set<StepKey>([
  'account',
  'terms',
  'dpa',
  'billing_mandate',
  'results_channel',
  'tracking_test',
  'team',
]);

/** VTID-05238: steps whose owner is fixed to the assistant. */
const ASSISTANT_STEPS: ReadonlySet<StepKey> = new Set<StepKey>(['company', 'catalogue', 'mapping']);

/**
 * VTID-05238: verification codes the assistant can resolve itself
 * (`update_business`, `check_verification`). `website` is prepended when the
 * org has no website host (partner-onboarding-service.ts:720, R1-F2).
 */
const ASSISTANT_VERIFICATION_CODES: ReadonlySet<string> = new Set([
  'website',
  'vat_id',
  'vat_invalid',
  'email_check_unavailable',
  'domain_check_unavailable',
  'vat_check_unavailable',
]);

/** VTID-05238: verification codes only the supplier can resolve. */
const SUPPLIER_VERIFICATION_CODES: ReadonlySet<string> = new Set(['email_not_verified', 'domain_proof']);

/**
 * VTID-05238 — who can finish an open step. Pure: no I/O, no lifecycle. Null
 * for a step that is `done`, `not_required`, or not required for the type.
 *
 * - `company`, `catalogue` (incl. a catalogue step carrying `catalogue_fixes`),
 *   `mapping` → `assistant`.
 * - `terms`, `dpa`, `billing_mandate`, `results_channel`, `tracking_test`,
 *   `team`, `account` → `supplier`.
 * - `verification`, first match wins:
 *     1. `step.missing` contains `facts_changed` → `assistant` (re-run the
 *        checks on the new facts). `step.detail.missing` is ignored here: on a
 *        stale verification `buildChecklist` keeps the stored row's `detail`
 *        (lines ~258–267), so its codes describe the old facts (R1-F1).
 *     2. `step.detail.review_note` present → `supplier`.
 *     3. the codes in `step.missing` ∪ `step.detail.missing`:
 *        a. any supplier code (`email_not_verified`, `domain_proof`) →
 *           `supplier`.
 *        b. any unknown code (not supplier/assistant/`business_verification*`/
 *           `licence*`) → `supplier`, so a brand-new check never silently
 *           claims the AI can do it — this is checked BEFORE the assistant
 *           codes, so `['vat_id','some_new_check']` → `supplier` (R2-F2).
 *        c. any assistant code (`website`, `vat_id`, `vat_invalid`,
 *           `*_check_unavailable`) → `assistant`.
 *        d. any `business_verification*`/`licence*` code → `vitanaland`.
 *     4. no codes: `in_progress` → `vitanaland` (a review is under way);
 *        `todo`/`failed` → `assistant` — a never-checked step with no codes
 *        means "run the checks", which is the assistant's job (R2-F1). So
 *        `vitanaland` applies only to a `business_verification*`/`licence*`
 *        code or to `in_progress` with no code, never to an empty todo/failed.
 */
export function stepOwner(step: ChecklistStep): StepOwner | null {
  if (!step.required) return null;
  if (step.status === 'done' || step.status === 'not_required') return null;

  if (ASSISTANT_STEPS.has(step.key)) return 'assistant';
  if (SUPPLIER_STEPS.has(step.key)) return 'supplier';

  if (step.key === 'verification') {
    const own = step.missing ?? [];
    // 1. facts changed: the assistant re-runs the checks; stale detail ignored.
    if (own.includes('facts_changed')) return 'assistant';
    // 2. a reviewer asked the supplier for a change.
    const reviewNote = (step.detail as Record<string, unknown> | undefined)?.review_note;
    if (reviewNote != null) return 'supplier';
    // 3./4. the open codes decide.
    const detailMissing = Array.isArray((step.detail as Record<string, unknown> | undefined)?.missing)
      ? ((step.detail as Record<string, unknown>).missing as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    const codes = [...own, ...detailMissing];
    // a. a supplier code: only the supplier can resolve it.
    if (codes.some((c) => SUPPLIER_VERIFICATION_CODES.has(c))) return 'supplier';
    // b. an unknown code takes precedence over an assistant code, so a new
    //    check never silently claims the AI can do it (R2-F2). business_
    //    verification*/licence* are known-vitanaland, not unknown.
    const isVitanalandCode = (c: string) => /^(business_verification|licence)/.test(c);
    const known = new Set([...SUPPLIER_VERIFICATION_CODES, ...ASSISTANT_VERIFICATION_CODES]);
    const unknownCode = codes.find((c) => !known.has(c) && !isVitanalandCode(c));
    if (unknownCode) return 'supplier';
    // c. an assistant code: the assistant can resolve it.
    if (codes.some((c) => ASSISTANT_VERIFICATION_CODES.has(c))) return 'assistant';
    // d. a business_verification*/licence* code → Vitanaland review.
    if (codes.some(isVitanalandCode)) return 'vitanaland';
    // No codes at all: an in_progress review is Vitanaland's; a never-checked
    // todo/failed means "run the checks", which is the assistant's job (R2-F1).
    return step.status === 'in_progress' ? 'vitanaland' : 'assistant';
  }

  return null;
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
        } else if (
          (input.termsBaselineVersions ?? [input.currentTermsVersion]).some((v) => input.acceptedTermsVersions.includes(v))
        ) {
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
        // VTID-04953 (B3): no external catalogue connection → mapping is
        // complete once there is one complete offering. A stored mapping row
        // only comes from the connections reconcile, so it is ignored here;
        // with a connection, that row stays the source of truth (below).
        if (key === 'mapping' && input.catalogueSource.connections === 0) {
          const n = input.catalogueSource.completeOfferings;
          status = n >= 1 ? 'done' : 'todo';
          if (n < 1) missing = ['complete_offering'];
          detail = { source: 'catalogue', complete_offerings: n };
          break;
        }
        const row = stored.get(key);
        if (row && isStepStatus(row.status)) {
          status = row.status;
          if (row.detail && typeof row.detail === 'object') detail = row.detail;
          // VTID-04486: a verification result only holds for the facts it
          // checked. Once the website, country or VAT id changes it is void.
          if (key === 'verification' && verificationIsStale(row.detail, input.org)) {
            status = 'todo';
            missing = ['facts_changed'];
          }
        }
      }
    }

    // VTID-05153: rows the catalogue check sent back are named on the
    // catalogue step. Status stays as it is, so lifecycle, submit and go-live
    // decide exactly as before.
    const returned = input.catalogueSource.returnedProducts ?? 0;
    if (key === 'catalogue' && returned > 0) {
      missing = [...(missing ?? []), 'catalogue_fixes'];
      detail = { ...(detail ?? {}), returned_products: returned };
    }

    if (!isRequired && key !== 'team' && status === 'todo') status = 'not_required';
    const step: ChecklistStep = { key, required: isRequired, status };
    if (missing) step.missing = missing;
    if (detail) step.detail = detail;
    // VTID-05238: additive owner on every open required step. No other field
    // changes; a done/not_required/not-required step gets none.
    const owner = stepOwner(step);
    if (owner) step.owner = owner;
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
