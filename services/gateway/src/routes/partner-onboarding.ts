/**
 * VTID-04478 — partner onboarding engine API, mounted at
 * /api/v1/partner-onboarding (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.2).
 *
 * This slice: POST /start, GET /:orgId, PATCH /:orgId/company,
 * POST /:orgId/terms/accept, POST /:orgId/submit, and (VTID-04481)
 * POST /:orgId/detect, and (VTID-04486) POST /:orgId/verification/check.
 * The catalogue step lives in partner-onboarding-catalogue.ts (VTID-04488),
 * connections in partner-onboarding-connections.ts (VTID-04499).
 * The remaining §6.2 endpoints (tracking test, DPA, billing mandate, Stripe
 * Connect verification) each
 * write their own step row into
 * partner_onboarding_steps when they land; the checklist here already reads
 * those rows.
 *
 * Every lifecycle move goes through canTransition() and is written with a
 * guard on the state it leaves, so two concurrent submits cannot both move
 * the org. Each move emits `partner_org.lifecycle_changed`.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  isPartnerType,
  parseCompanyFacts,
} from '../services/partner-lifecycle';
import {
  buildChecklist,
  type Checklist,
} from '../services/partner-onboarding-checklist';
import { getCallerId, isExafyAdmin, requireOrgAdmin } from './partner-orgs';
import {
  checkVerification,
  detectStore,
  startOnboarding,
  submitForVerification,
  updateCompany,
  type Caller,
} from '../services/partner-onboarding-service';
import { detectPlatform } from '../services/platform-detect';
import { availableTermsLocales, loadBaselineVersions, loadCurrentTerms, requestDelegation, termsForDisplay } from '../services/partner-terms';
import { VERIFICATION_LEVEL_REQUIRED, verificationIsStale } from '../services/partner-onboarding-checklist';
import {
  computeVerification,
  domainProofInstructions,
  domainsMatch,
  emailDomainOf,
  hostOf,
  htmlContainsMetaToken,
  isEuCountry,
  normalizeVatNumber,
  txtRecordsContainToken,
  type CheckStatus,
  type VerificationChecks,
} from '../services/partner-verification';
import {
  checkVatVies,
  fetchSiteHtml,
  lookupDomainProofTxt,
  readEmailConfirmation,
} from '../services/partner-verification-io';

const router = Router();

/** The authenticated caller as the onboarding service sees it. */
function callerOf(req: Request, callerId: string): Caller {
  const identity = (req as AuthenticatedRequest).identity;
  return { userId: callerId, exafyAdmin: isExafyAdmin(req), email: identity?.email ?? null, tenantId: identity?.tenant_id ?? null };
}

export type Supa = NonNullable<ReturnType<typeof getSupabase>>;

const ORG_FIELDS =
  'id, org_key, display_name, partner_type, commerce_vertical, lifecycle_state, status, trust_level, legal_name, country, vat_id, website, owner_user_id, created_at';


export interface OrgRow {
  id: string;
  org_key: string;
  display_name: string;
  partner_type: string | null;
  commerce_vertical: string | null;
  lifecycle_state: string;
  status: string;
  trust_level: number;
  legal_name: string | null;
  country: string | null;
  vat_id: string | null;
  website: string | null;
  owner_user_id: string;
  created_at: string;
}


export function makeOrgKey(displayName: string, suffix: string = randomBytes(3).toString('hex')): string {
  const slug = displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${slug || 'partner'}-${suffix}`;
}

export async function loadOrg(supabase: Supa, orgId: string): Promise<{ org: OrgRow | null; error: string | null }> {
  const { data, error } = await supabase.from('partner_organizations').select(ORG_FIELDS).eq('id', orgId).maybeSingle();
  if (error) return { org: null, error: error.message };
  return { org: (data as OrgRow | null) ?? null, error: null };
}

export async function loadChecklist(supabase: Supa, org: OrgRow): Promise<{ checklist: Checklist | null; error: string | null }> {
  if (!isPartnerType(org.partner_type)) return { checklist: null, error: null };

  // VTID-04895: the terms in force come from partner_terms_versions (fails
  // closed to "not published"), and any version sharing its baseline counts.
  const currentTerms = await loadCurrentTerms(supabase);
  const termsBaselineVersions = currentTerms ? await loadBaselineVersions(supabase, currentTerms) : undefined;

  const [steps, terms, members] = await Promise.all([
    supabase.from('partner_onboarding_steps').select('step_key, status, detail, updated_at').eq('partner_organization_id', org.id),
    supabase.from('partner_terms_acceptances').select('terms_version').eq('partner_organization_id', org.id),
    supabase
      .from('partner_organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('partner_organization_id', org.id),
  ]);
  const failed = [steps, terms, members].find((r) => r.error);
  if (failed?.error) return { checklist: null, error: failed.error.message };

  const checklist = buildChecklist({
    org: {
      partner_type: org.partner_type,
      legal_name: org.legal_name,
      country: org.country,
      vat_id: org.vat_id,
      website: org.website,
    },
    storedSteps: (steps.data ?? []) as Array<{ step_key: string; status: string; detail?: Record<string, unknown> | null }>,
    acceptedTermsVersions: ((terms.data ?? []) as Array<{ terms_version: string }>).map((t) => t.terms_version),
    currentTermsVersion: currentTerms?.version ?? null,
    termsBaselineVersions,
    memberCount: typeof members.count === 'number' ? members.count : 1,
  });
  return { checklist, error: null };
}

function publicOrg(org: OrgRow) {
  const { owner_user_id: _owner, ...rest } = org;
  return rest;
}

export async function respondWithState(res: Response, supabase: Supa, orgId: string, status = 200, extra: Record<string, unknown> = {}) {
  const { org, error } = await loadOrg(supabase, orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });
  const loaded = await loadChecklist(supabase, org);
  if (loaded.error) return res.status(500).json({ ok: false, error: loaded.error });
  return res.status(status).json({ ok: true, organization: publicOrg(org), checklist: loaded.checklist, ...extra });
}

// ==================== Start ====================

router.post('/start', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  // VTID-04847: the rules live in services/partner-onboarding-service.ts.
  const r = await startOnboarding(supabase, callerOf(req, callerId), req.body ?? {});
  return res.status(r.status).json(r.body);
});

// ==================== Status ====================

router.get('/:orgId', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  return respondWithState(res, supabase, req.params.orgId);
});

// ==================== Company ====================

router.patch('/:orgId/company', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const r = await updateCompany(supabase, { ...callerOf(req, callerId), orgAdminChecked: true }, req.params.orgId, req.body);
  return res.status(r.status).json(r.body);
});

// ==================== Detect (VTID-04481) ====================

/**
 * Website → storefront platform detection and company pre-fill (spec §6.2).
 * Reuses the SSRF-guarded detector the VCAOP portal already uses. The result
 * is kept on the org (business_details.platform_detection) so the
 * connections step can pick the right connector later; the pre-fill is
 * returned as suggestions only — nothing about the company is written until
 * the partner confirms it through PATCH /company.
 */
router.post('/:orgId/detect', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const r = await detectStore(supabase, { ...callerOf(req, callerId), orgAdminChecked: true }, req.params.orgId, { website: req.body?.website });
  return res.status(r.status).json(r.body);
});

// ==================== Verification (VTID-04486) ====================

/**
 * Runs the automated verification checks of spec §7 and records the result
 * as the `verification` step row: the checks, the level reached, the facts
 * checked (a later change to them voids the result) and, while ownership is
 * unproven, the token the partner puts in DNS or a meta tag. trust_level is
 * set to the level reached (0 when none, the column's floor).
 */
router.post('/:orgId/verification/check', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  // VTID-04941: the checks live in the onboarding service, shared with the Commerce MCP.
  const r = await checkVerification(supabase, { ...callerOf(req, callerId), orgAdminChecked: true }, req.params.orgId);
  return res.status(r.status).json(r.body);
});

// ==================== Terms ====================

/**
 * VTID-04895: the terms in force, as the supplier reads them before accepting:
 * the version, its content hash and whether this org has already accepted
 * (under the re-acceptance baseline).
 * VTID-04909: one language at a time — `?locale=` (the app language, or the
 * one the supplier switched to), German when that language is missing — with
 * the binding German text and the list of languages the version carries. The
 * hash is the German text's, whatever language is shown.
 */
router.get('/:orgId/terms', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const current = await loadCurrentTerms(supabase);
  if (!current) return res.status(200).json({ ok: true, published: false, terms: null, accepted: false });

  const baseline = await loadBaselineVersions(supabase, current);
  const { data, error } = await supabase
    .from('partner_terms_acceptances')
    .select('terms_version, accepted_at')
    .eq('partner_organization_id', req.params.orgId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const rows = (data ?? []) as Array<{ terms_version: string; accepted_at: string }>;
  const accepted = rows.find((r) => baseline.includes(r.terms_version)) ?? null;
  const locale = typeof req.query.locale === 'string' ? req.query.locale : null;

  return res.status(200).json({
    ok: true,
    published: true,
    terms: termsForDisplay(current, locale),
    accepted: Boolean(accepted),
    accepted_at: accepted?.accepted_at ?? null,
    // Accepted an earlier baseline, not this one: a material update needs re-acceptance.
    reacceptance_required: !accepted && rows.length > 0,
  });
});

router.post('/:orgId/terms/accept', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const orgId = req.params.orgId;
  const callerId = getCallerId(req);

  // VTID-04895: only the supplier's own session accepts. An AI assistant's
  // delegated OAuth token — or a token whose origin cannot be established —
  // is refused before anything else is looked at.
  const delegation = await requestDelegation(supabase, (req as AuthenticatedRequest).auth_raw_claims as Record<string, unknown> | undefined);
  if (delegation !== 'direct') {
    console.warn(`[VTID-04895] terms acceptance refused for org ${orgId}: ${delegation} session`);
    return res.status(403).json({
      ok: false,
      error: 'TERMS_ACCEPTANCE_REQUIRES_SUPPLIER',
      message: 'The partner terms are accepted by the supplier on Vitanaland itself, never by an assistant.',
    });
  }

  const current = await loadCurrentTerms(supabase);
  if (!current) return res.status(503).json({ ok: false, error: 'TERMS_NOT_PUBLISHED' });
  if (req.body?.terms_version !== current.version) {
    return res.status(409).json({ ok: false, error: 'TERMS_VERSION_MISMATCH', current_version: current.version });
  }
  // The text accepted is exactly the text shown.
  if (req.body?.content_sha256 !== current.content_sha256) {
    return res.status(409).json({ ok: false, error: 'TERMS_CONTENT_MISMATCH', current_version: current.version });
  }
  // VTID-04909: the language that was on screen — one this version carries.
  // It is recorded, never part of the hash: German is binding.
  const shownLocale = typeof req.body?.shown_locale === 'string' ? req.body.shown_locale : '';
  const available = availableTermsLocales(current);
  if (!(available as string[]).includes(shownLocale)) {
    return res.status(400).json({ ok: false, error: 'INVALID_SHOWN_LOCALE', available_locales: available });
  }

  const { org, error } = await loadOrg(supabase, orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });

  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : null;
  const { error: insErr } = await supabase.from('partner_terms_acceptances').insert({
    partner_organization_id: orgId,
    terms_version: current.version,
    terms_version_id: current.id,
    content_sha256: current.content_sha256,
    shown_locale: shownLocale,
    accepted_by: callerId,
    ip_address: req.ip ?? null,
    user_agent: userAgent,
  });
  const alreadyAccepted = insErr?.code === '23505';
  if (insErr && !alreadyAccepted) {
    // A new version was published between the read and the insert: the
    // database trigger refuses the stale version/hash.
    if (/PARTNER_TERMS_(VERSION_NOT_CURRENT|CONTENT_MISMATCH)/.test(insErr.message ?? '')) {
      return res.status(409).json({ ok: false, error: 'TERMS_CONTENT_MISMATCH' });
    }
    return res.status(500).json({ ok: false, error: insErr.message });
  }

  if (!alreadyAccepted) {
    await emitOasisEvent({
      vtid: 'VTID-04895',
      type: 'partner_org.terms_accepted',
      source: 'partner-onboarding',
      status: 'success',
      message: `Partner organization ${orgId} accepted the partner terms ${current.version}.`,
      // IP and user agent stay in the acceptance row only.
      payload: {
        partner_organization_id: orgId,
        terms_version: current.version,
        terms_version_id: current.id,
        content_sha256: current.content_sha256,
        shown_locale: shownLocale,
      },
      actor_id: callerId ?? undefined,
    });
  }

  return respondWithState(res, supabase, orgId, 200, { already_accepted: alreadyAccepted });
});

// ==================== Submit ====================

router.post('/:orgId/submit', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const r = await submitForVerification(supabase, { ...callerOf(req, callerId), orgAdminChecked: true }, req.params.orgId);
  return res.status(r.status).json(r.body);
});

export default router;
