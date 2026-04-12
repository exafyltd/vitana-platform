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
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../../lib/supabase';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';

const router = Router({ mergeParams: true }); // mergeParams to access :tenantId from parent

const VTID = 'TENANT-INVITATIONS';

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

    const grantRoles = Array.isArray(roles) && roles.length > 0 ? roles : ['community'];

    // Check for existing pending invitation for this email+tenant
    const { data: existing } = await supabase
      .from('tenant_invitations')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('email', email.toLowerCase().trim())
      .is('accepted_at', null)
      .is('revoked_at', null)
      .single();

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: 'ALREADY_INVITED',
        message: `A pending invitation already exists for ${email} in this tenant.`,
      });
    }

    // Create invitation
    const { data: invitation, error } = await supabase
      .from('tenant_invitations')
      .insert({
        tenant_id: tenantId,
        email: email.toLowerCase().trim(),
        roles: grantRoles,
        invited_by: req.identity!.user_id,
        message: message || null,
      })
      .select('*')
      .single();

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

    let query = supabase
      .from('tenant_invitations')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (status === 'pending') {
      query = query.is('accepted_at', null).is('revoked_at', null);
    } else if (status === 'accepted') {
      query = query.not('accepted_at', 'is', null);
    } else if (status === 'revoked') {
      query = query.not('revoked_at', 'is', null);
    }

    const { data, error } = await query;

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

    const { data, error } = await supabase
      .from('tenant_invitations')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: req.identity!.user_id,
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .select('*')
      .single();

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
    const { data: invitation, error: findError } = await supabase
      .from('tenant_invitations')
      .select('*')
      .eq('token', token)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .single();

    if (findError || !invitation) {
      return res.status(404).json({ ok: false, error: 'INVALID_TOKEN', message: 'Invitation not found, expired, or already used.' });
    }

    // Check expiry
    if (new Date(invitation.expires_at) < new Date()) {
      return res.status(410).json({ ok: false, error: 'EXPIRED', message: 'This invitation has expired.' });
    }

    const userId = req.identity!.user_id;

    // Ensure user has a user_tenants row for this tenant
    const { data: existingMembership } = await supabase
      .from('user_tenants')
      .select('id')
      .eq('user_id', userId)
      .eq('tenant_id', invitation.tenant_id)
      .single();

    if (!existingMembership) {
      // Create membership with the first offered role as active_role
      await supabase.from('user_tenants').insert({
        user_id: userId,
        tenant_id: invitation.tenant_id,
        active_role: invitation.roles[0] || 'community',
        is_primary: false,
      });
    }

    // Grant all offered roles via user_permitted_roles
    for (const role of invitation.roles) {
      await supabase
        .from('user_permitted_roles')
        .upsert(
          {
            user_id: userId,
            tenant_id: invitation.tenant_id,
            role,
            granted_by: invitation.invited_by,
          },
          { onConflict: 'user_id,tenant_id,role' }
        );
    }

    // Mark invitation as accepted
    await supabase
      .from('tenant_invitations')
      .update({
        accepted_at: new Date().toISOString(),
        accepted_by: userId,
      })
      .eq('id', invitation.id);

    console.log(`[${VTID}] Invitation accepted: ${invitation.id} by user ${userId}, roles: ${invitation.roles.join(', ')}`);

    return res.json({
      ok: true,
      message: `Welcome! You've been granted the following roles: ${invitation.roles.join(', ')}`,
      tenant_id: invitation.tenant_id,
      roles: invitation.roles,
    });
  } catch (err: any) {
    console.error(`[${VTID}] Accept error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});
