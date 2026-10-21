/**
 * VTID-03834 — shared tenant/role auth helpers, extracted verbatim from
 * routes/role-admin.ts (VTID-01230) so backoffice-access.ts reuses the exact
 * same identity + tenant-membership checks instead of carrying a copy.
 */
import { Request } from 'express';
import { createUserSupabaseClient } from './supabase-user';

const VTID = 'VTID-01230';

export type TenantRoleAuth =
  | { ok: true; user_id: string; email: string; is_exafy_admin: boolean; tenant_id: string | null; active_role: string | null; token: string }
  | { ok: false; status: number; error: string };

export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Verify caller identity and return auth context.
 */
export async function verifyAuth(req: Request): Promise<
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
    const { data: meData, error: meError } = await userClient.rpc('me_context');
    if (meError) {
      // Fail closed either way (unchanged) — a caller who is genuinely a
      // tenant admin loses tenant_id/active_role and is denied downstream
      // by canManageRoles(); logged so that isn't mistaken for the caller
      // genuinely lacking admin rights.
      console.warn(`[${VTID}] me_context RPC error:`, meError.message);
    }
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
export async function canManageRoles(
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

