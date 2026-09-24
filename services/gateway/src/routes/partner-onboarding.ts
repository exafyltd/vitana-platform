/**
 * VTID-04478 — partner onboarding engine API, mounted at
 * /api/v1/partner-onboarding (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.2).
 *
 * This slice: POST /start, GET /:orgId, PATCH /:orgId/company,
 * POST /:orgId/terms/accept, POST /:orgId/submit, and (VTID-04481)
 * POST /:orgId/detect. The remaining §6.2 endpoints (catalogue,
 * connections, tracking test, DPA, billing mandate, verification) each
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
  PARTNER_TYPES,
  canTransition,
  isLifecycleState,
  isPartnerType,
  parseCompanyFacts,
  type LifecycleState,
  type PartnerType,
} from '../services/partner-lifecycle';
import {
  buildChecklist,
  evaluateVerification,
  submitTransitions,
  type Checklist,
} from '../services/partner-onboarding-checklist';
import { getCallerId, requireOrgAdmin } from './partner-orgs';
import { detectPlatform } from '../services/platform-detect';

const router = Router();

type Supa = NonNullable<ReturnType<typeof getSupabase>>;

const ORG_FIELDS =
  'id, org_key, display_name, partner_type, commerce_vertical, lifecycle_state, status, trust_level, legal_name, country, vat_id, website, owner_user_id, created_at';

/** States in which the partner may still edit the company facts. */
const COMPANY_EDITABLE_STATES: readonly LifecycleState[] = ['draft', 'needs_action'];

interface OrgRow {
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

/** The partner terms version in force. Unset means no terms are published yet. */
export function currentTermsVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.PARTNER_TERMS_VERSION?.trim();
  return v ? v : null;
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

async function loadOrg(supabase: Supa, orgId: string): Promise<{ org: OrgRow | null; error: string | null }> {
  const { data, error } = await supabase.from('partner_organizations').select(ORG_FIELDS).eq('id', orgId).maybeSingle();
  if (error) return { org: null, error: error.message };
  return { org: (data as OrgRow | null) ?? null, error: null };
}

async function loadChecklist(supabase: Supa, org: OrgRow): Promise<{ checklist: Checklist | null; error: string | null }> {
  if (!isPartnerType(org.partner_type)) return { checklist: null, error: null };

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
    currentTermsVersion: currentTermsVersion(),
    memberCount: typeof members.count === 'number' ? members.count : 1,
  });
  return { checklist, error: null };
}

function publicOrg(org: OrgRow) {
  const { owner_user_id: _owner, ...rest } = org;
  return rest;
}

async function respondWithState(res: Response, supabase: Supa, orgId: string, status = 200, extra: Record<string, unknown> = {}) {
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

  // The account step is "a signed-in user with an email address".
  const email = (req as AuthenticatedRequest).identity?.email;
  if (!email) return res.status(403).json({ ok: false, error: 'ACCOUNT_EMAIL_REQUIRED' });

  const partnerType = req.body?.partner_type;
  if (!isPartnerType(partnerType)) {
    return res.status(400).json({ ok: false, error: `partner_type must be one of: ${PARTNER_TYPES.join(', ')}` });
  }
  const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
  if (!displayName || displayName.length > 200) {
    return res.status(400).json({ ok: false, error: 'display_name is required (at most 200 characters)' });
  }

  // Idempotent per user + type while the org is still a draft.
  const existing = await supabase
    .from('partner_organizations')
    .select('id')
    .eq('owner_user_id', callerId)
    .eq('partner_type', partnerType)
    .eq('lifecycle_state', 'draft')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) return res.status(500).json({ ok: false, error: existing.error.message });
  if (existing.data) {
    return respondWithState(res, supabase, (existing.data as { id: string }).id, 200, { created: false });
  }

  let orgId: string | null = null;
  for (let attempt = 0; attempt < 2 && !orgId; attempt++) {
    const { data, error } = await supabase
      .from('partner_organizations')
      .insert({
        org_key: makeOrgKey(displayName),
        display_name: displayName,
        org_type: partnerType,
        partner_type: partnerType,
        lifecycle_state: 'draft',
        owner_user_id: callerId,
        business_details: {},
      })
      .select('id')
      .single();
    if (data) orgId = (data as { id: string }).id;
    else if (error?.code !== '23505') {
      return res.status(500).json({ ok: false, error: error?.message ?? 'partner_organizations insert failed' });
    }
  }
  if (!orgId) return res.status(500).json({ ok: false, error: 'ORG_KEY_COLLISION' });

  const { error: memberErr } = await supabase
    .from('partner_organization_members')
    .insert({ partner_organization_id: orgId, user_id: callerId, role: 'org_admin', granted_by: callerId });
  if (memberErr) return res.status(500).json({ ok: false, error: memberErr.message });

  await emitOasisEvent({
    vtid: 'VTID-04478',
    type: 'partner_org.onboarding_started',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner onboarding started for "${displayName}" (${partnerType}).`,
    payload: { partner_organization_id: orgId, partner_type: partnerType },
    actor_id: callerId,
  });

  return respondWithState(res, supabase, orgId, 201, { created: true });
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
  const orgId = req.params.orgId;

  const { org, error } = await loadOrg(supabase, orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });
  // Changing verified facts on a submitted or live org needs a re-verification
  // flow, which does not exist yet.
  if (!COMPANY_EDITABLE_STATES.includes(org.lifecycle_state as LifecycleState)) {
    return res.status(409).json({ ok: false, error: 'COMPANY_LOCKED', lifecycle_state: org.lifecycle_state });
  }

  const parsed = parseCompanyFacts(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  if (Object.keys(parsed.facts).length === 0) {
    return res.status(400).json({ ok: false, error: 'at least one of legal_name, country, vat_id, website is required' });
  }

  const { error: updErr } = await supabase
    .from('partner_organizations')
    .update({ ...parsed.facts, updated_at: new Date().toISOString() })
    .eq('id', orgId);
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  await emitOasisEvent({
    vtid: 'VTID-04478',
    type: 'partner_org.company_updated',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId} updated its company facts.`,
    // Field names only: the values (VAT id, legal name) stay in the org row.
    payload: { partner_organization_id: orgId, fields: Object.keys(parsed.facts) },
    actor_id: getCallerId(req) ?? undefined,
  });

  return respondWithState(res, supabase, orgId);
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
  const orgId = req.params.orgId;

  const { data: row, error } = await supabase
    .from('partner_organizations')
    .select('id, website, business_details')
    .eq('id', orgId)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!row) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });
  const current = row as { id: string; website: string | null; business_details: Record<string, unknown> | null };

  const requested = req.body?.website;
  let website: string | null = current.website;
  if (requested !== undefined && requested !== null && requested !== '') {
    const parsed = parseCompanyFacts({ website: requested });
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
    website = parsed.facts.website ?? null;
  }
  if (!website) return res.status(400).json({ ok: false, error: 'WEBSITE_REQUIRED' });

  const detection = await detectPlatform(website);
  if (!detection.ok) {
    return res.status(422).json({ ok: false, error: 'DETECTION_FAILED', reason: detection.error ?? 'unknown' });
  }

  const record = {
    url: website,
    connector_id: detection.connector_id ?? null,
    provider_id: detection.provider_id ?? null,
    platform_name: detection.name_hint ?? null,
    confidence: detection.confidence ?? 'none',
    detected_at: new Date().toISOString(),
  };
  const { error: updErr } = await supabase
    .from('partner_organizations')
    .update({
      business_details: { ...(current.business_details ?? {}), platform_detection: record },
      updated_at: new Date().toISOString(),
    })
    .eq('id', orgId);
  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  await emitOasisEvent({
    vtid: 'VTID-04481',
    type: 'partner_org.platform_detected',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId}: storefront platform ${record.connector_id ?? 'not recognised'} (${record.confidence}).`,
    payload: {
      partner_organization_id: orgId,
      connector_id: record.connector_id,
      provider_id: record.provider_id,
      confidence: record.confidence,
    },
    actor_id: getCallerId(req) ?? undefined,
  });

  return respondWithState(res, supabase, orgId, 200, {
    detection: record,
    suggested: { website, display_name: detection.site_name ?? null },
  });
});

// ==================== Terms ====================

router.post('/:orgId/terms/accept', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const orgId = req.params.orgId;
  const callerId = getCallerId(req);

  const current = currentTermsVersion();
  if (!current) return res.status(503).json({ ok: false, error: 'TERMS_NOT_PUBLISHED' });
  if (req.body?.terms_version !== current) {
    return res.status(409).json({ ok: false, error: 'TERMS_VERSION_MISMATCH', current_version: current });
  }

  const { org, error } = await loadOrg(supabase, orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });

  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : null;
  const { error: insErr } = await supabase.from('partner_terms_acceptances').insert({
    partner_organization_id: orgId,
    terms_version: current,
    accepted_by: callerId,
    ip_address: req.ip ?? null,
    user_agent: userAgent,
  });
  const alreadyAccepted = insErr?.code === '23505';
  if (insErr && !alreadyAccepted) return res.status(500).json({ ok: false, error: insErr.message });

  if (!alreadyAccepted) {
    await emitOasisEvent({
      vtid: 'VTID-04478',
      type: 'partner_org.terms_accepted',
      source: 'partner-onboarding',
      status: 'success',
      message: `Partner organization ${orgId} accepted the partner terms ${current}.`,
      payload: { partner_organization_id: orgId, terms_version: current },
      actor_id: callerId ?? undefined,
    });
  }

  return respondWithState(res, supabase, orgId, 200, { already_accepted: alreadyAccepted });
});

// ==================== Submit ====================

router.post('/:orgId/submit', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const orgId = req.params.orgId;
  const callerId = getCallerId(req);

  const { org, error } = await loadOrg(supabase, orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });
  if (!isPartnerType(org.partner_type)) {
    return res.status(409).json({ ok: false, error: 'PARTNER_TYPE_MISSING' });
  }
  if (!isLifecycleState(org.lifecycle_state)) {
    return res.status(500).json({ ok: false, error: `unknown lifecycle_state ${org.lifecycle_state}` });
  }

  const loaded = await loadChecklist(supabase, org);
  if (loaded.error || !loaded.checklist) return res.status(500).json({ ok: false, error: loaded.error ?? 'checklist unavailable' });
  const checklist = loaded.checklist;

  if (!checklist.submit_ready) {
    return res.status(409).json({ ok: false, error: 'SUBMIT_PREREQUISITES_MISSING', missing: checklist.submit_missing, checklist });
  }

  const verdict = evaluateVerification(checklist);
  const moves = submitTransitions(org.lifecycle_state, verdict.outcome);
  if (!moves) {
    return res.status(409).json({ ok: false, error: 'NOT_SUBMITTABLE', lifecycle_state: org.lifecycle_state });
  }

  const applied: Array<{ from: LifecycleState; to: LifecycleState }> = [];
  for (const move of moves) {
    if (!canTransition(move.from, move.to)) {
      return res.status(500).json({ ok: false, error: `illegal transition ${move.from} -> ${move.to}` });
    }
    const { data, error: updErr } = await supabase
      .from('partner_organizations')
      .update({ lifecycle_state: move.to, updated_at: new Date().toISOString() })
      .eq('id', orgId)
      .eq('lifecycle_state', move.from)
      .select('id');
    if (updErr) return res.status(500).json({ ok: false, error: updErr.message, applied });
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(409).json({ ok: false, error: 'CONCURRENT_UPDATE', applied });
    }
    applied.push(move);

    await emitOasisEvent({
      vtid: 'VTID-04478',
      type: 'partner_org.lifecycle_changed',
      source: 'partner-onboarding',
      status: move.to === 'needs_action' ? 'warning' : 'success',
      message: `Partner organization ${orgId}: ${move.from} -> ${move.to}.`,
      payload: {
        partner_organization_id: orgId,
        partner_type: org.partner_type as PartnerType,
        from: move.from,
        to: move.to,
        reason: 'submit',
        ...(move.to === 'needs_action' ? { open_steps: verdict.open_steps, failed_steps: verdict.failed_steps } : {}),
      },
      actor_id: callerId ?? undefined,
    });
  }

  return respondWithState(res, supabase, orgId, 200, {
    transitions: applied,
    open_steps: verdict.open_steps,
  });
});

export default router;
