/**
 * Batch 1.B1: Tenant Invitations API
 *
 * Endpoints (mounted under /api/v1/admin/tenants/:tenantId/invitations):
 *   POST   /           — Create invitation (sends email, stores token)
 *   GET    /           — List invitations for tenant
 *   POST   /:id/revoke — Revoke a pending invitation
 *
 * Public endpoint (mounted separately):
 *   POST   /api/v1/admin/invitations/accept/:token — Accept invitation (no admin check)
 *
 * Security: tenant-admin RBAC via requireTenantAdmin middleware
 *
 * VTID-05044 (Track S / S4):
 *   - create validates every role against VITANA_ROLES (400 INVALID_ROLE) and
 *     refuses SUPER_ADMIN_ONLY_ROLES unless the caller is exafy_admin (403
 *     ROLE_NOT_GRANTABLE) — the same rule role-admin.ts applies to direct grants.
 *   - accept requires a confirmed email that matches the invitation
 *     (case-insensitive; 403 EMAIL_UNVERIFIED / EMAIL_MISMATCH), re-checks the
 *     stored roles (409 INVITATION_ROLES_INVALID for invites created before
 *     the create-time check), and claims the invitation atomically BEFORE any
 *     membership or role is written (409 ALREADY_USED for the loser of a race).
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../../lib/supabase';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import * as repo from '../../services/tenant-invitations/tenant-invitations-repository';
import { isVitanaRole, SUPER_ADMIN_ONLY_ROLES, VALID_ROLES } from '../../constants/vitana-roles';

const router = Router({ mergeParams: true }); // mergeParams to access :tenantId from parent

const VTID = 'TENANT-INVITATIONS';

const isSuperAdminOnlyRole = (role: string): boolean =>
  (SUPER_ADMIN_ONLY_ROLES as readonly string[]).includes(role);

// ── POST / — Create invitation ─────────────────────────────────

router.post('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { email, roles, message } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'INVALID_EMAIL', message: 'A valid email is required.' });
    }

    const requestedRoles: unknown[] = Array.isArray(roles) && roles.length > 0 ? roles : ['community'];

    // VTID-05044: only real Vitana roles, and developer/infra only from an exafy_admin.
    const invalidRoles = requestedRoles.filter((r) => !isVitanaRole(r));
    if (invalidRoles.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_ROLE',
        message: 'One or more roles are not valid Vitana roles.',
        valid_roles: VALID_ROLES,
      });
    }
    const grantRoles = Array.from(new Set(requestedRoles as string[]));
    const restricted = grantRoles.filter(isSuperAdminOnlyRole);
    if (restricted.length > 0 && !req.identity?.exafy_admin) {
      return res.status(403).json({
        ok: false,
        error: 'ROLE_NOT_GRANTABLE',
        message: `Only super admins can invite with the role(s): ${restricted.join(', ')}`,
      });
    }

    // Check for existing pending invitation for this email+tenant.
    // .single() reports PGRST116 ("no rows") for the normal "not yet
    // invited" case — that is not a failure, only a genuine error is.
    const { data: existing, error: existingErr } = await repo.fetchExistingPendingInvitation(supabase, tenantId, email.toLowerCase().trim());
    if (existingErr && existingErr.code !== 'PGRST116') {
      console.error(`[${VTID}] Existing-invitation check error:`, existingErr.message);
      return res.status(500).json({ ok: false, error: existingErr.message });
    }

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: 'ALREADY_INVITED',
        message: `A pending invitation already exists for ${email} in this tenant.`,
      });
    }

    // Create invitation
    const { data: invitation, error } = await repo.insertInvitation(supabase, {
      tenant_id: tenantId,
      email: email.toLowerCase().trim(),
      roles: grantRoles,
      invited_by: req.identity!.user_id,
      message: message || null,
    });

    if (error) {
      console.error(`[${VTID}] Insert error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    // TODO: Send invitation email via existing notifications path
    // For now, return the token so the admin can share it manually
    console.log(`[${VTID}] Invitation created: ${invitation.id} for ${email} in tenant ${tenantId}`);

    return res.status(201).json({
      ok: true,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        roles: invitation.roles,
        token: invitation.token,
        expires_at: invitation.expires_at,
        created_at: invitation.created_at,
        accept_url: `/admin/invitations/accept/${invitation.token}`,
      },
    });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET / — List invitations ─────────────────────────────────

router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const status = (req.query.status as string || '').trim();

    const { data, error } = await repo.fetchInvitations(supabase, tenantId, status);

    if (error) {
      console.error(`[${VTID}] List error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, invitations: data || [] });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── POST /:id/revoke — Revoke invitation ─────────────────────

router.post('/:id/revoke', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { id } = req.params;

    const { data, error } = await repo.revokeInvitation(supabase, id, tenantId, {
      revoked_at: new Date().toISOString(),
      revoked_by: req.identity!.user_id,
    });

    if (error || !data) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Invitation not found or already used/revoked.' });
    }

    console.log(`[${VTID}] Invitation revoked: ${id} by ${req.identity!.user_id}`);
    return res.json({ ok: true, invitation: data });
  } catch (err: any) {
    console.error(`[${VTID}] Error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;

// ── Accept invitation (public, separate router) ─────────────

export const acceptRouter = Router();

acceptRouter.post('/accept/:token', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { token } = req.params;

    // Find the invitation
    const { data: invitation, error: findError } = await repo.fetchInvitationByToken(supabase, token);

    if (findError || !invitation) {
      return res.status(404).json({ ok: false, error: 'INVALID_TOKEN', message: 'Invitation not found, expired, or already used.' });
    }

    // Check expiry
    if (new Date(invitation.expires_at) < new Date()) {
      return res.status(410).json({ ok: false, error: 'EXPIRED', message: 'This invitation has expired.' });
    }

    const userId = req.identity!.user_id;

    // VTID-05044: the token alone is not enough — the caller must own the
    // invited address, and must have confirmed it.
    const { data: authData, error: authErr } = await repo.fetchAuthUserById(supabase, userId);
    if (authErr) {
      console.error(`[${VTID}] Accepting-user lookup error:`, authErr.message);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
    const authUser = authData?.user;
    if (!authUser || !authUser.email_confirmed_at) {
      return res.status(403).json({
        ok: false,
        error: 'EMAIL_UNVERIFIED',
        message: 'Please confirm your email address before accepting this invitation.',
      });
    }
    const callerEmail = (authUser.email || '').trim().toLowerCase();
    const invitedEmail = String(invitation.email || '').trim().toLowerCase();
    if (!callerEmail || callerEmail !== invitedEmail) {
      return res.status(403).json({
        ok: false,
        error: 'EMAIL_MISMATCH',
        message: 'This invitation was sent to a different email address. Ask the tenant admin to invite the address you signed in with.',
      });
    }

    // VTID-05044: re-check the stored roles. Invitations created before the
    // create-time check may carry unknown roles, or developer/infra from a
    // tenant admin; neither is honoured. Unknown roles are refused outright.
    const invitedRoles: unknown[] = Array.isArray(invitation.roles) ? invitation.roles : [];
    if (invitedRoles.some((r) => !isVitanaRole(r))) {
      return res.status(409).json({
        ok: false,
        error: 'INVITATION_ROLES_INVALID',
        message: 'This invitation carries roles that cannot be granted. Ask the tenant admin for a new invitation.',
      });
    }
    if ((invitedRoles as string[]).some(isSuperAdminOnlyRole)) {
      const { data: inviterData, error: inviterErr } = await repo.fetchAuthUserById(supabase, invitation.invited_by);
      if (inviterErr) {
        console.error(`[${VTID}] Inviter lookup error:`, inviterErr.message);
        return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
      }
      if ((inviterData?.user?.app_metadata as Record<string, unknown> | undefined)?.exafy_admin !== true) {
        return res.status(409).json({
          ok: false,
          error: 'INVITATION_ROLES_INVALID',
          message: 'This invitation carries roles that cannot be granted. Ask the tenant admin for a new invitation.',
        });
      }
    }
    const grantRoles = Array.from(new Set(invitedRoles as string[]));

    // Ensure user has a user_tenants row for this tenant.
    // .single() reports PGRST116 ("no rows") for the normal "not yet a
    // member" case — that is not a failure, only a genuine error is. A
    // real error here must not fall through to the (!existingMembership)
    // branch below, which would insert a fresh row and reset active_role
    // even for a user who already has a membership.
    const { data: existingMembership, error: existingMembershipErr } = await repo.fetchUserTenantMembership(supabase, userId, invitation.tenant_id);
    if (existingMembershipErr && existingMembershipErr.code !== 'PGRST116') {
      console.error(`[${VTID}] Existing-membership check error:`, existingMembershipErr.message);
      return res.status(500).json({ ok: false, error: existingMembershipErr.message });
    }

    // VTID-05044: claim before granting. Only the request whose conditional
    // update returns the row may write memberships/roles.
    const { data: claimed, error: claimErr } = await repo.claimInvitation(supabase, invitation.id, userId);
    if (claimErr) {
      console.error(`[${VTID}] Claim error:`, claimErr.message);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
    if (!claimed) {
      return res.status(409).json({
        ok: false,
        error: 'ALREADY_USED',
        message: 'This invitation has already been used or is no longer valid.',
      });
    }

    if (!existingMembership) {
      // Create membership with the first offered role as active_role
      await repo.insertUserTenantMembership(supabase, {
        user_id: userId,
        tenant_id: invitation.tenant_id,
        active_role: grantRoles[0] || 'community',
        is_primary: false,
      });
    }

    // Grant all offered roles via user_permitted_roles
    for (const role of grantRoles) {
      await repo.upsertUserPermittedRole(supabase, {
        user_id: userId,
        tenant_id: invitation.tenant_id,
        role,
        granted_by: invitation.invited_by,
      });
    }

    console.log(`[${VTID}] Invitation accepted: ${invitation.id} by user ${userId}, roles: ${grantRoles.join(', ')}`);

    return res.json({
      ok: true,
      message: `Welcome! You've been granted the following roles: ${grantRoles.join(', ')}`,
      tenant_id: invitation.tenant_id,
      roles: grantRoles,
    });
  } catch (err: any) {
    console.error(`[${VTID}] Accept error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});
