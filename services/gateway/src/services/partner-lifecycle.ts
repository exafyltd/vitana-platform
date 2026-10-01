/**
 * VTID-04471 — partner organization account model: types, lifecycle and the
 * rules the onboarding engine applies (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §5).
 *
 * Pure functions only, no I/O, the same shape as VCAOP's canTransition. The
 * database (migration 20260924130000_vtid_04471_partner_account_model.sql)
 * guarantees every value is valid and keeps the legacy `status` column in
 * sync; which transitions are allowed is decided here.
 *
 * The mappings below must match the SQL helpers
 * partner_org_status_for_lifecycle() and partner_org_vertical_for_type();
 * the VTID-04471 test reads the migration and fails if they drift.
 */

export const PARTNER_TYPES = [
  'lab',
  'supplier_shop',
  'practitioner_clinic',
  'service_provider',
  'affiliate_brand',
] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const LIFECYCLE_STATES = [
  'draft',
  'submitted',
  'verifying',
  'needs_action',
  'exception',
  'live',
  'paused',
  'suspended',
  'rejected',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export type LegacyOrgStatus = 'pending_review' | 'active' | 'suspended' | 'rejected';
export type CommerceVertical = 'health' | 'general';

/**
 * Spec §5.2:
 *   draft → submitted → verifying → live
 *   verifying → needs_action (partner fixes, back to verifying)
 *   verifying → exception (Vitana review queue) → live | needs_action | rejected
 *   verifying → rejected
 *   live ⇄ paused (automatic, recoverable by the partner)
 *   live → suspended (Vitana, exception outcome) → live (reinstated)
 * `rejected` is terminal.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  draft: ['submitted'],
  submitted: ['verifying'],
  verifying: ['live', 'needs_action', 'exception', 'rejected'],
  needs_action: ['verifying'],
  exception: ['live', 'needs_action', 'rejected'],
  live: ['paused', 'suspended'],
  paused: ['live'],
  suspended: ['live'],
  rejected: [],
};

export function isPartnerType(value: unknown): value is PartnerType {
  return typeof value === 'string' && (PARTNER_TYPES as readonly string[]).includes(value);
}

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Mirrors SQL partner_org_status_for_lifecycle(). */
export function statusForLifecycle(state: LifecycleState): LegacyOrgStatus {
  switch (state) {
    case 'live':
      return 'active';
    case 'paused':
    case 'suspended':
      return 'suspended';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending_review';
  }
}

/** Mirrors SQL partner_org_vertical_for_type(). */
export function verticalForPartnerType(type: PartnerType): CommerceVertical {
  return type === 'lab' || type === 'practitioner_clinic' ? 'health' : 'general';
}

// ---------------------------------------------------------------------------
// Company facts collected during onboarding
// ---------------------------------------------------------------------------

export interface CompanyFacts {
  legal_name?: string;
  country?: string;
  vat_id?: string;
  website?: string;
}

const MAX_TEXT = 200;

/**
 * Validates the optional company facts from a request body. Absent or empty
 * fields are left out; a present but invalid field is an error, never
 * silently dropped.
 */
export function parseCompanyFacts(body: unknown): { ok: true; facts: CompanyFacts } | { ok: false; error: string } {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const facts: CompanyFacts = {};

  for (const key of ['legal_name', 'vat_id'] as const) {
    const raw = src[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > MAX_TEXT) {
      return { ok: false, error: `${key} must be a non-empty string of at most ${MAX_TEXT} characters` };
    }
    facts[key] = raw.trim();
  }

  const country = src.country;
  if (country !== undefined && country !== null && country !== '') {
    if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country.trim())) {
      return { ok: false, error: 'country must be a two-letter ISO 3166-1 code' };
    }
    facts.country = country.trim().toUpperCase();
  }

  const website = src.website;
  if (website !== undefined && website !== null && website !== '') {
    let url: URL | null = null;
    try {
      url = typeof website === 'string' && website.trim().length <= MAX_TEXT ? new URL(website.trim()) : null;
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return { ok: false, error: 'website must be an http(s) URL' };
    }
    facts.website = url.toString();
  }

  return { ok: true, facts };
}
