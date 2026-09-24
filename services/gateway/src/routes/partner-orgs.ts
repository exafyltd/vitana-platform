/**
 * VTID-03932 — Commerce Partner Onboarding (Phase 1): self-service partner
 * organization registration + org-scoped staff/professional roster.
 *
 * Mounted at /api/v1/partner-orgs. Every authenticated Vitana user (already
 * auto-community per the existing provision_platform_user() trigger) can
 * register a business; the registering caller becomes that org's first
 * org_admin. Auth here is deliberately re-keyed from tenant_id to
 * partner_organization_id — the same shape as
 * services/backoffice/erp-access.ts's effectiveCapabilities()/
 * canManageErpAccess() and routes/backoffice-access.ts's requireManager(),
 * just scoped to a partner org instead of a tenant's ERP capabilities.
 *
 * partner_organizations/partner_organization_members/
 * partner_organization_invites are defined in
 * supabase/migrations/20260915120000_vtid_03932_partner_organizations.sql.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { getUserLocale } from '../i18n/server-locale';
import { buildInviteAcceptUrl, sendPartnerInviteEmail } from '../services/email/partner-invite-email';
import { PARTNER_TYPES, isPartnerType, parseCompanyFacts, verticalForPartnerType } from '../services/partner-lifecycle';

const router = Router();

const ORG_ROLES = ['org_admin', 'staff', 'professional'] as const;
type OrgRole = (typeof ORG_ROLES)[number];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// VTID-04337 (SEC-3) — the only statuses /:orgId/activate may move from.
// 'rejected' is terminal for this endpoint; reversing a rejection is a
// deliberate decision that needs its own path, not a side effect of activate.
export const ACTIVATABLE_STATUSES = ['pending_review', 'suspended', 'active'] as const;

// VTID-03974 — the machine-readable routing signal that decides whether an
// activated org gets a partner_registry bridge (see POST /:orgId/activate
// below). Deliberately separate from org_type, which stays free-text.
const COMMERCE_VERTICALS = ['health', 'general'] as const;
type CommerceVertical = (typeof COMMERCE_VERTICALS)[number];

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

function isCommerceVertical(value: unknown): value is CommerceVertical {
  return typeof value === 'string' && (COMMERCE_VERTICALS as readonly string[]).includes(value);
}

export function getCallerId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.user_id ?? null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function isExafyAdmin(req: Request): boolean {
  return (req as AuthenticatedRequest).identity?.exafy_admin === true;
}

/**
 * Re-keyed equivalent of canManageErpAccess()/canManageRoles(): true if the
 * caller is a global exafy_admin, OR holds org_admin for THIS specific
 * partner_organization_id. Never widened to "any staff" — inviting/removing
 * members is an org_admin-only action, matching backoffice-access.ts's
 * requireManager() precedent.
 */
async function callerIsOrgAdmin(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  callerId: string,
  orgId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('partner_organization_members')
    .select('role')
    .eq('partner_organization_id', orgId)
    .eq('user_id', callerId)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { role: string }).role === 'org_admin';
}

/**
 * Middleware factory: requires the caller to be exafy_admin OR org_admin
 * for :orgId. Mirrors backoffice-access.ts's requireManager() shape.
 */
export function requireOrgAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const callerId = getCallerId(req);
    if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

    const orgId = req.params.orgId;
    if (isExafyAdmin(req)) return next();

    const isAdmin = await callerIsOrgAdmin(supabase, callerId, orgId);
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'NOT_ORG_ADMIN', message: 'Only this organization\'s own org_admin (or an exafy_admin) can perform this action.' });
    }
    return next();
  };
}

// ==================== Register ====================

router.post('/register', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const orgKey = typeof req.body?.org_key === 'string' ? req.body.org_key.trim().toLowerCase() : '';
  const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
  const orgType = typeof req.body?.org_type === 'string' ? req.body.org_type.trim() : '';
  const rawPartnerType = req.body?.partner_type;
  let commerceVertical = req.body?.commerce_vertical;
  const businessDetails = req.body?.business_details && typeof req.body.business_details === 'object' ? req.body.business_details : {};

  if (!orgKey) return res.status(400).json({ ok: false, error: 'org_key is required' });
  if (!displayName) return res.status(400).json({ ok: false, error: 'display_name is required' });
  if (!orgType) return res.status(400).json({ ok: false, error: 'org_type is required' });
  // VTID-04471 — partner_type is the enforced vocabulary; when given it
  // decides commerce_vertical (the DB trigger derives it the same way).
  // Without it, commerce_vertical stays required as before.
  const partnerType = rawPartnerType === undefined || rawPartnerType === null || rawPartnerType === '' ? null : rawPartnerType;
  if (partnerType !== null && !isPartnerType(partnerType)) {
    return res.status(400).json({ ok: false, error: `partner_type must be one of: ${PARTNER_TYPES.join(', ')}` });
  }
  if (partnerType !== null) {
    const derived = verticalForPartnerType(partnerType);
    if (commerceVertical !== undefined && commerceVertical !== null && commerceVertical !== derived) {
      return res.status(400).json({ ok: false, error: `commerce_vertical must be '${derived}' for partner_type '${partnerType}'` });
    }
    commerceVertical = derived;
  }
  if (!isCommerceVertical(commerceVertical)) {
    return res.status(400).json({ ok: false, error: `commerce_vertical must be one of: ${COMMERCE_VERTICALS.join(', ')}` });
  }
  const companyFacts = parseCompanyFacts(req.body);
  if (!companyFacts.ok) return res.status(400).json({ ok: false, error: companyFacts.error });

  const { data: org, error: orgErr } = await supabase
    .from('partner_organizations')
    .insert({
      org_key: orgKey,
      display_name: displayName,
      org_type: orgType,
      commerce_vertical: commerceVertical,
      status: 'pending_review',
      owner_user_id: callerId,
      business_details: businessDetails,
      ...(partnerType !== null ? { partner_type: partnerType } : {}),
      ...companyFacts.facts,
    })
    .select('id, org_key, display_name, org_type, partner_type, commerce_vertical, status, lifecycle_state, legal_name, country, vat_id, website')
    .single();
  if (orgErr || !org) {
    if (orgErr?.code === '23505') return res.status(409).json({ ok: false, error: 'org_key already taken' });
    return res.status(500).json({ ok: false, error: orgErr?.message ?? 'partner_organizations insert failed' });
  }
  const orgRow = org as {
    id: string;
    org_key: string;
    display_name: string;
    org_type: string;
    partner_type: string | null;
    commerce_vertical: CommerceVertical;
    status: string;
    lifecycle_state: string;
  };

  const { error: memberErr } = await supabase
    .from('partner_organization_members')
    .insert({ partner_organization_id: orgRow.id, user_id: callerId, role: 'org_admin', granted_by: callerId });
  if (memberErr) return res.status(500).json({ ok: false, error: memberErr.message });

  await emitOasisEvent({
    vtid: 'VTID-03932',
    type: 'partner_org.registered',
    source: 'partner-orgs',
    status: 'success',
    message: `Partner organization "${orgRow.display_name}" (${orgRow.org_key}) self-registered by ${callerId}.`,
    payload: { partner_organization_id: orgRow.id, org_key: orgRow.org_key, org_type: orgRow.org_type, partner_type: orgRow.partner_type ?? null },
    actor_id: callerId,
  });

  return res.status(201).json({ ok: true, organization: orgRow });
});

// ==================== Mine ====================

/**
 * VTID-03935 — Phase 2 (frontend) needs a way for a caller to discover
 * which org(s) they belong to and their role in each, without already
 * knowing an orgId. Any member (not just org_admin) — this is a read of
 * the caller's own memberships, not a management action.
 */
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const { data, error } = await supabase
    .from('partner_organization_members')
    .select('role, partner_organizations(id, org_key, display_name, org_type, partner_type, status, lifecycle_state)')
    .eq('user_id', callerId);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  type OrgEmbed = {
    id: string;
    org_key: string;
    display_name: string;
    org_type: string;
    partner_type: string | null;
    status: string;
    lifecycle_state: string;
  };
  const organizations = ((data ?? []) as Array<{ role: string; partner_organizations: OrgEmbed | OrgEmbed[] | null }>)
    .map((row) => {
      const org = Array.isArray(row.partner_organizations) ? row.partner_organizations[0] : row.partner_organizations;
      return org ? { ...org, role: row.role } : null;
    })
    .filter((org): org is OrgEmbed & { role: string } => org !== null);

  return res.json({ ok: true, organizations });
});

// ==================== Members ====================

router.get('/:orgId/members', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase
    .from('partner_organization_members')
    .select('id, user_id, role, granted_by, granted_at')
    .eq('partner_organization_id', req.params.orgId)
    .order('granted_at', { ascending: true });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, members: data ?? [] });
});

router.post('/:orgId/members/invite', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const orgId = req.params.orgId;
  const callerId = getCallerId(req);
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const role = req.body?.role;
  if (!email) return res.status(400).json({ ok: false, error: 'email is required' });
  if (!isOrgRole(role)) return res.status(400).json({ ok: false, error: `role must be one of: ${ORG_ROLES.join(', ')}` });

  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data: invite, error: inviteErr } = await supabase
    .from('partner_organization_invites')
    .insert({ partner_organization_id: orgId, email, role, invited_by: callerId, token, expires_at: expiresAt })
    .select('id, email, role, expires_at, token')
    .single();
  if (inviteErr || !invite) return res.status(500).json({ ok: false, error: inviteErr?.message ?? 'partner_organization_invites insert failed' });

  // VTID-04463 — send the accept link to the invitee. Best effort: the invite
  // already exists, and the response always carries the link so the admin can
  // share it by hand when email is off, unconfigured or refused.
  const acceptUrl = buildInviteAcceptUrl(token);
  let emailOutcome: Awaited<ReturnType<typeof sendPartnerInviteEmail>>;
  try {
    const { data: org } = await supabase
      .from('partner_organizations')
      .select('display_name')
      .eq('id', orgId)
      .maybeSingle();
    const locale = await getUserLocale(supabase, callerId ?? '');
    emailOutcome = await sendPartnerInviteEmail({
      to: email,
      orgName: (org as { display_name?: string } | null)?.display_name ?? 'Vitanaland',
      role,
      acceptUrl,
      validDays: Math.round(INVITE_TTL_MS / (24 * 60 * 60 * 1000)),
      locale,
    });
  } catch (err) {
    emailOutcome = { sent: false, status: 'failed', error: (err as Error)?.message ?? String(err) };
  }
  if (!emailOutcome.sent && emailOutcome.status !== 'disabled') {
    console.warn(`[partner-orgs] invite ${(invite as { id: string }).id} email not sent: ${emailOutcome.status}${emailOutcome.error ? ` (${emailOutcome.error})` : ''}`);
  }

  await emitOasisEvent({
    vtid: 'VTID-03932',
    type: 'partner_org.member_invited',
    source: 'partner-orgs',
    status: 'success',
    message: `Partner organization ${orgId} invited ${email} as "${role}".`,
    payload: {
      partner_organization_id: orgId,
      role,
      invite_id: (invite as { id: string }).id,
      email_status: emailOutcome.status,
    },
    actor_id: callerId ?? undefined,
  });

  return res.status(201).json({
    ok: true,
    invite,
    accept_url: acceptUrl,
    email: { sent: emailOutcome.sent, status: emailOutcome.status },
  });
});

/**
 * VTID-03935 — the roster UI needs to show pending invites alongside the
 * members list; org_admin-only, same gate as the members list itself.
 */
router.get('/:orgId/invites', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const { data, error } = await supabase
    .from('partner_organization_invites')
    .select('id, email, role, token, expires_at, accepted_at')
    .eq('partner_organization_id', req.params.orgId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, invites: data ?? [] });
});

router.post('/invites/:token/accept', requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const callerId = getCallerId(req);
  if (!callerId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const { data: invite, error: inviteErr } = await supabase
    .from('partner_organization_invites')
    .select('id, partner_organization_id, email, role, expires_at, accepted_at')
    .eq('token', req.params.token)
    .maybeSingle();
  if (inviteErr) return res.status(500).json({ ok: false, error: inviteErr.message });
  if (!invite) return res.status(404).json({ ok: false, error: 'invite not found' });
  const inv = invite as { id: string; partner_organization_id: string; email: string; role: OrgRole; expires_at: string; accepted_at: string | null };

  // VTID-04337 (SEC-1) — an invite belongs to the address it was sent to.
  // Before this, anyone holding the link joined with the invited role. The
  // JWT email is the account's confirmed address; an identity without one
  // (e.g. a token type that carries no email claim) cannot prove it is the
  // invitee and is refused rather than waved through. The invited address is
  // deliberately not echoed back to a caller who does not own it.
  const callerEmail = normalizeEmail((req as AuthenticatedRequest).identity?.email);
  if (!callerEmail) {
    return res.status(403).json({ ok: false, error: 'INVITE_EMAIL_UNVERIFIED', message: 'Sign in with the email address this invite was sent to.' });
  }
  if (callerEmail !== normalizeEmail(inv.email)) {
    return res.status(403).json({ ok: false, error: 'INVITE_EMAIL_MISMATCH', message: 'This invite was sent to a different email address. Sign in with that address to accept it.' });
  }

  if (inv.accepted_at) return res.status(409).json({ ok: false, error: 'invite already accepted' });
  if (new Date(inv.expires_at).getTime() < Date.now()) return res.status(410).json({ ok: false, error: 'invite expired' });

  const { error: memberErr } = await supabase
    .from('partner_organization_members')
    .upsert(
      { partner_organization_id: inv.partner_organization_id, user_id: callerId, role: inv.role, granted_by: null },
      { onConflict: 'partner_organization_id,user_id' }
    );
  if (memberErr) return res.status(500).json({ ok: false, error: memberErr.message });

  await supabase
    .from('partner_organization_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', inv.id);

  await emitOasisEvent({
    vtid: 'VTID-03932',
    type: 'partner_org.member_joined',
    source: 'partner-orgs',
    status: 'success',
    message: `User ${callerId} accepted a "${inv.role}" invite to partner organization ${inv.partner_organization_id}.`,
    payload: { partner_organization_id: inv.partner_organization_id, role: inv.role },
    actor_id: callerId,
  });

  return res.json({ ok: true, partner_organization_id: inv.partner_organization_id, role: inv.role });
});

// ==================== Admin activation (exafy_admin only) ====================
// Mounted under the same /api/v1/partner-orgs prefix as everything else in
// this router (see index.ts) — i.e. reachable at
// POST /api/v1/partner-orgs/:orgId/activate. exafy_admin-gated, mirroring
// the existing VCAOP certified->active precedent (routes/vcaop-portal.ts).

router.post('/:orgId/activate', requireAuth, async (req: Request, res: Response) => {
  if (!isExafyAdmin(req)) return res.status(403).json({ ok: false, error: 'EXAFY_ADMIN_REQUIRED' });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  // VTID-04337 (SEC-3) — the update is conditional on the CURRENT status,
  // so a rejected org can no longer be activated by a stray call. Doing it
  // in the UPDATE's own WHERE (not a read-then-write) closes the race with a
  // concurrent reject. 'active' stays in the set so re-activation remains
  // the idempotent no-op the health-registry bridge below relies on.
  const { data: org, error } = await supabase
    .from('partner_organizations')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', req.params.orgId)
    .in('status', [...ACTIVATABLE_STATUSES])
    .select('id, org_key, display_name, commerce_vertical, status')
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!org) {
    // Nothing matched: either the org does not exist, or its status forbids
    // activation. Tell the two apart so the caller gets an honest answer.
    const { data: existing, error: lookupErr } = await supabase
      .from('partner_organizations')
      .select('id, status')
      .eq('id', req.params.orgId)
      .maybeSingle();
    if (lookupErr) return res.status(500).json({ ok: false, error: lookupErr.message });
    if (!existing) return res.status(404).json({ ok: false, error: 'organization not found' });
    const current = (existing as { status: string }).status;
    return res.status(409).json({
      ok: false,
      error: 'ORG_NOT_ACTIVATABLE',
      message: `An organization in status "${current}" cannot be activated.`,
      status: current,
    });
  }
  const orgRow = org as { id: string; org_key: string; display_name: string; commerce_vertical: CommerceVertical | null; status: string };

  await emitOasisEvent({
    vtid: 'VTID-03932',
    type: 'partner_org.activated',
    source: 'partner-orgs',
    status: 'success',
    message: `Partner organization ${orgRow.display_name} activated by exafy_admin.`,
    payload: { partner_organization_id: req.params.orgId },
    actor_id: getCallerId(req) ?? undefined,
  });

  // VTID-03974 — health-vertical bridge: without this, an activated org can
  // never receive an order, because partner_health_test_orders.partner_id
  // references partner_registry, not partner_organizations. Find-or-create
  // keyed on partner_key = org_key (stable, traceable back to the org),
  // so re-activating an already-bridged org is a no-op, never a duplicate.
  // A general-commerce org never gets a partner_registry row.
  if (orgRow.commerce_vertical === 'health') {
    const { data: existingRegistry } = await supabase
      .from('partner_registry')
      .select('id')
      .eq('partner_key', orgRow.org_key)
      .maybeSingle();

    if (!existingRegistry) {
      const { data: registry, error: registryErr } = await supabase
        .from('partner_registry')
        .insert({
          partner_key: orgRow.org_key,
          display_name: orgRow.display_name,
          integration_mode: 'portal_manual',
          status: 'active',
          capabilities: { has_order_api: false, has_webhook: false, has_result_api: false },
          partner_organization_id: orgRow.id,
        })
        .select('id')
        .single();
      if (registryErr || !registry) {
        return res.status(500).json({ ok: false, error: registryErr?.message ?? 'partner_registry bridge insert failed', organization: orgRow });
      }

      await emitOasisEvent({
        vtid: 'VTID-03974',
        type: 'partner_org.registry_linked',
        source: 'partner-orgs',
        status: 'success',
        message: `Partner organization ${orgRow.display_name} bridged to a new partner_registry row for health-order processing.`,
        payload: { partner_organization_id: orgRow.id, partner_registry_id: (registry as { id: string }).id },
        actor_id: getCallerId(req) ?? undefined,
      });
    }
  }

  return res.json({ ok: true, organization: org });
});

export default router;
