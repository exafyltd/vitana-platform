/**
 * VTID-01230: Role Admission Management Routes
 *
 * Endpoints:
 * - GET  /my-roles          - List caller's own permitted roles
 * - GET  /users/:userId     - List permitted roles for a user (exafy_admin or tenant admin)
 * - POST /grant             - Grant a role to a user (exafy_admin or tenant admin)
 * - POST /revoke            - Revoke a role from a user (exafy_admin or tenant admin)
 *
 * Security:
 * - All endpoints require valid Bearer token
 * - /my-roles: any authenticated user
 * - /users/:userId, /grant, /revoke: exafy_admin OR tenant admin (active_role='admin' + same tenant)
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();
const VTID = 'VTID-01230';

// Valid roles that can be granted
const VALID_ROLES = ['community', 'patient', 'professional', 'staff', 'admin', 'developer', 'infra'];

// =============================================================================
// Helpers
// =============================================================================

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Verify caller identity and return auth context.
 */
async function verifyAuth(req: Request): Promise<
  | { ok: true; user_id: string; email: string; is_exafy_admin: boolean; tenant_id: string | null; active_role: string | null; token: string }
  | { ok: false; status: number; error: string }
> {
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: 'UNAUTHENTICATED' };
  }

  try {
    const userClient = createUserSupabaseClient(token);
    const { data: authData, error: authError } = await userClient.auth.getUser();

    if (authError || !authData?.user) {
      console.warn(`[${VTID}] Failed to get user from token:`, authError?.message);
      return { ok: false, status: 401, error: 'INVALID_TOKEN' };
    }

    const user = authData.user;
    const appMetadata = user.app_metadata || {};
    const isExafyAdmin = appMetadata.exafy_admin === true;

    // Get tenant context via me_context RPC
    const { data: meData } = await userClient.rpc('me_context');
    const tenantId = meData?.tenant_id || null;
    const activeRole = meData?.active_role || null;

    return {
      ok: true,
      user_id: user.id,
      email: user.email || 'unknown',
      is_exafy_admin: isExafyAdmin,
      tenant_id: tenantId,
      active_role: activeRole,
      token,
    };
  } catch (err: any) {
    console.error(`[${VTID}] Auth error:`, err.message);
    return { ok: false, status: 500, error: 'INTERNAL_ERROR' };
  }
}

/**
 * Check if caller can manage roles for a target user.
 * Returns true if: exafy_admin OR (active_role='admin' AND same tenant as target)
 */
async function canManageRoles(
  caller: { is_exafy_admin: boolean; tenant_id: string | null; active_role: string | null; token: string },
  targetUserId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Super admin can manage anyone
  if (caller.is_exafy_admin) {
    return { allowed: true };
  }

  // Must be a tenant admin
  if (caller.active_role !== 'admin') {
    return { allowed: false, reason: 'Only admins can manage roles' };
  }

  if (!caller.tenant_id) {
    return { allowed: false, reason: 'No tenant context' };
  }

  // Check target user is in the same tenant
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { allowed: false, reason: 'Service configuration error' };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/user_tenants?user_id=eq.${targetUserId}&tenant_id=eq.${caller.tenant_id}&select=user_id`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      return { allowed: false, reason: 'Failed to verify tenant membership' };
    }

    const rows = await response.json() as any[];
    if (rows.length === 0) {
      return { allowed: false, reason: 'Target user is not in your tenant' };
    }

    return { allowed: true };
  } catch (err: any) {
    console.error(`[${VTID}] Tenant check error:`, err.message);
    return { allowed: false, reason: 'Internal error checking tenant' };
  }
}

// =============================================================================
// GET /my-roles — List caller's own permitted roles
// =============================================================================

router.get('/my-roles', async (req: Request, res: Response) => {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }

  try {
    const userClient = createUserSupabaseClient(auth.token);
    const { data, error } = await userClient.rpc('get_my_permitted_roles');

    if (error) {
      console.error(`[${VTID}] GET /my-roles RPC error:`, error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }

    return res.status(200).json(data);
  } catch (err: any) {
    console.error(`[${VTID}] GET /my-roles error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// GET /users/:userId — List permitted roles for a user (admin only)
// =============================================================================

router.get('/users/:userId', async (req: Request, res: Response) => {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }

  const targetUserId = req.params.userId;

  // Check caller permission
  const permission = await canManageRoles(auth, targetUserId);
  if (!permission.allowed) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: permission.reason });
  }

  // Fetch permitted roles via service role
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }

  try {
    // If exafy_admin, get roles across all tenants. If tenant admin, filter to their tenant.
    let url = `${supabaseUrl}/rest/v1/user_permitted_roles?user_id=eq.${targetUserId}&select=id,role,tenant_id,granted_by,granted_at`;
    if (!auth.is_exafy_admin && auth.tenant_id) {
      url += `&tenant_id=eq.${auth.tenant_id}`;
    }

    const response = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Fetch roles error:`, errorText);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }

    const roles = await response.json() as any[];

    return res.status(200).json({
      ok: true,
      user_id: targetUserId,
      roles: roles.map((r: any) => r.role),
      details: roles,
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /users/:userId error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// POST /grant — Grant a role to a user
// =============================================================================

router.post('/grant', async (req: Request, res: Response) => {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }

  const { user_id: targetUserId, role, tenant_id: requestedTenantId } = req.body;

  // Validate inputs
  if (!targetUserId) {
    return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
  }
  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, error: 'INVALID_ROLE', valid_roles: VALID_ROLES });
  }

  // Developer and infra roles can only be granted by super admin (exafy_admin)
  const SUPER_ADMIN_ONLY_ROLES = ['developer', 'infra'];
  if (SUPER_ADMIN_ONLY_ROLES.includes(role) && !auth.is_exafy_admin) {
    return res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: `Only super admins can grant the '${role}' role`,
    });
  }

  // Check caller permission
  const permission = await canManageRoles(auth, targetUserId);
  if (!permission.allowed) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: permission.reason });
  }

  // Determine tenant_id: exafy_admin can specify any, tenant admin uses their own
  const tenantId = auth.is_exafy_admin
    ? (requestedTenantId || auth.tenant_id)
    : auth.tenant_id;

  if (!tenantId) {
    return res.status(400).json({ ok: false, error: 'NO_TENANT_CONTEXT' });
  }

  // Insert via service role
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/user_permitted_roles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_id: targetUserId,
        tenant_id: tenantId,
        role,
        granted_by: auth.user_id,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Handle duplicate (conflict)
      if (response.status === 409 || errorText.includes('duplicate') || errorText.includes('unique')) {
        return res.status(200).json({ ok: true, message: 'Role already granted', role, user_id: targetUserId });
      }
      console.error(`[${VTID}] Grant error:`, errorText);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }

    const result = await response.json();
    console.log(`[${VTID}] Role granted: ${role} to ${targetUserId} by ${auth.email}`);

    return res.status(200).json({
      ok: true,
      message: `Role '${role}' granted`,
      user_id: targetUserId,
      tenant_id: tenantId,
      role,
      granted_by: auth.user_id,
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /grant error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// POST /revoke — Revoke a role from a user
// =============================================================================

router.post('/revoke', async (req: Request, res: Response) => {
  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.error });
  }

  const { user_id: targetUserId, role, tenant_id: requestedTenantId } = req.body;

  // Validate inputs
  if (!targetUserId) {
    return res.status(400).json({ ok: false, error: 'MISSING_USER_ID' });
  }
  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, error: 'INVALID_ROLE', valid_roles: VALID_ROLES });
  }

  // Prevent revoking 'community' — it's the minimum role
  if (role === 'community') {
    return res.status(400).json({ ok: false, error: 'CANNOT_REVOKE_COMMUNITY', message: 'The community role cannot be revoked' });
  }

  // Check caller permission
  const permission = await canManageRoles(auth, targetUserId);
  if (!permission.allowed) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN', message: permission.reason });
  }

  // Determine tenant_id
  const tenantId = auth.is_exafy_admin
    ? (requestedTenantId || auth.tenant_id)
    : auth.tenant_id;

  if (!tenantId) {
    return res.status(400).json({ ok: false, error: 'NO_TENANT_CONTEXT' });
  }

  // Delete via service role
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/user_permitted_roles?user_id=eq.${targetUserId}&tenant_id=eq.${tenantId}&role=eq.${encodeURIComponent(role)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'return=minimal',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${VTID}] Revoke error:`, errorText);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }

    console.log(`[${VTID}] Role revoked: ${role} from ${targetUserId} by ${auth.email}`);

    return res.status(200).json({
      ok: true,
      message: `Role '${role}' revoked`,
      user_id: targetUserId,
      tenant_id: tenantId,
      role,
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /revoke error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
