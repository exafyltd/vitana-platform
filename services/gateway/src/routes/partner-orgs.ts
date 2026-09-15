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

const router = Router();

const ORG_ROLES = ['org_admin', 'staff', 'professional'] as const;
type OrgRole = (typeof ORG_ROLES)[number];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

function getCallerId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.user_id ?? null;
}

function isExafyAdmin(req: Request): boolean {
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
function requireOrgAdmin() {
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
  const businessDetails = req.body?.business_details && typeof req.body.business_details === 'object' ? req.body.business_details : {};

  if (!orgKey) return res.status(400).json({ ok: false, error: 'org_key is required' });
  if (!displayName) return res.status(400).json({ ok: false, error: 'display_name is required' });
  if (!orgType) return res.status(400).json({ ok: false, error: 'org_type is required' });

  const { data: org, error: orgErr } = await supabase
    .from('partner_organizations')
    .insert({
      org_key: orgKey,
      display_name: displayName,
      org_type: orgType,
      status: 'pending_review',
      owner_user_id: callerId,
      business_details: businessDetails,
    })
    .select('id, org_key, display_name, org_type, status')
    .single();
  if (orgErr || !org) {
    if (orgErr?.code === '23505') return res.status(409).json({ ok: false, error: 'org_key already taken' });
    return res.status(500).json({ ok: false, error: orgErr?.message ?? 'partner_organizations insert failed' });
  }
  const orgRow = org as { id: string; org_key: string; display_name: string; org_type: string; status: string };

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
    payload: { partner_organization_id: orgRow.id, org_key: orgRow.org_key, org_type: orgRow.org_type },
    actor_id: callerId,
  });

  return res.status(201).json({ ok: true, organization: orgRow });
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

  await emitOasisEvent({
    vtid: 'VTID-03932',
    type: 'partner_org.member_invited',
    source: 'partner-orgs',
    status: 'success',
    message: `Partner organization ${orgId} invited ${email} as "${role}".`,
    payload: { partner_organization_id: orgId, role, invite_id: (invite as { id: string }).id },
    actor_id: callerId ?? undefined,
  });

  return res.status(201).json({ ok: true, invite });
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

  const { data: org, error } = await supabase
    .from('partner_organizations')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', req.params.orgId)
    .select('id, org_key, display_name, status')
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!org) return res.status(404).json({ ok: false, error: 'organization not found' });

  await emitOasisEvent({
    vtid: 'VTID-03932',
    type: 'partner_org.activated',
    source: 'partner-orgs',
    status: 'success',
    message: `Partner organization ${(org as { display_name: string }).display_name} activated by exafy_admin.`,
    payload: { partner_organization_id: req.params.orgId },
    actor_id: getCallerId(req) ?? undefined,
  });

  return res.json({ ok: true, organization: org });
});

export default router;
