/**
 * Batch 1.B1: Tenant-Admin RBAC Middleware
 *
 * Allows access if the caller is:
 *   (a) exafy_admin (super-admin, all tenants), OR
 *   (b) has active_role = 'admin' in the route's target tenant
 *
 * Expects the route to have :tenantId in the path (e.g. /api/v1/admin/tenants/:tenantId/...).
 * Rejects if:
 *   - No valid JWT (401)
 *   - No tenant_id in JWT (400)
 *   - Caller is not exafy_admin AND caller's tenant doesn't match :tenantId (403)
 *   - Caller is not exafy_admin AND caller's active_role is not 'admin' (403)
 *
 * Must be used on routes that accept :tenantId as a param.
 * For routes without :tenantId, uses the caller's own tenant_id from the JWT.
 */

import { Response, NextFunction } from 'express';
import {
  AuthenticatedRequest,
  verifyAndExtractIdentity,
} from './auth-supabase-jwt';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/**
 * Lookup the caller's active_role for a given tenant from user_tenants.
 * Returns the role string or null if not found.
 */
async function getCallerRole(userId: string, tenantId: string): Promise<string | null> {
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[require-tenant-admin] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { data, error } = await supabase
    .from('user_tenants')
    .select('active_role')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) return null;
  return data.active_role;
}

/**
 * Middleware: require tenant-admin access.
 *
 * Usage:
 *   router.get('/api/v1/admin/tenants/:tenantId/members', requireTenantAdmin, handler);
 *   router.get('/api/v1/admin/members', requireTenantAdmin, handler); // uses JWT tenant_id
 */
export async function requireTenantAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Step 1: Verify JWT
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Missing or invalid Authorization header. Expected: Bearer <token>',
    });
    return;
  }

  const token = authHeader.slice(7);
  const result = await verifyAndExtractIdentity(token);

  if (!result) {
    res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Invalid or expired token',
    });
    return;
  }

  req.identity = result.identity;
  req.auth_raw_claims = result.claims;
  req.auth_source = result.auth_source;

  // Step 2: Exafy super-admin bypasses all tenant checks
  if (req.identity.exafy_admin) {
    next();
    return;
  }

  // Step 3: Determine target tenant (from route param or JWT)
  const targetTenantId = (req.params.tenantId as string) || req.identity.tenant_id;

  if (!targetTenantId) {
    res.status(400).json({
      ok: false,
      error: 'TENANT_REQUIRED',
      message: 'No tenant_id in route params or JWT. Cannot determine target tenant.',
    });
    return;
  }

  // Step 4: Caller's JWT tenant must match the target tenant
  if (req.identity.tenant_id !== targetTenantId) {
    console.warn(
      `[require-tenant-admin] Cross-tenant access denied: user ${req.identity.user_id} ` +
      `(tenant ${req.identity.tenant_id}) tried to access tenant ${targetTenantId}`
    );
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'You can only manage your own tenant.',
    });
    return;
  }

  // Step 5: Caller must have active_role = 'admin' in their tenant
  const callerRole = await getCallerRole(req.identity.user_id, targetTenantId);

  if (callerRole !== 'admin') {
    console.warn(
      `[require-tenant-admin] Admin role required: user ${req.identity.user_id} ` +
      `has role '${callerRole}' in tenant ${targetTenantId}`
    );
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'This action requires the admin role within your tenant.',
    });
    return;
  }

  // Attach the resolved target tenant for downstream handlers
  (req as any).targetTenantId = targetTenantId;
  next();
}
