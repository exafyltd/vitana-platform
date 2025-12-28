import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();

// VTID-01048: Valid roles for active_role validation
const VALID_ROLES = ['community', 'patient', 'professional', 'staff', 'admin', 'developer'];

/**
 * Extract Bearer token from Authorization header.
 * @param req - Express request object
 * @returns The token string or null if not found/invalid format
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7); // Remove 'Bearer ' prefix
}

/**
 * VTID-01048: Helper to normalize RPC response to canonical me format.
 * Maps backend RPC response to the authoritative me context format.
 */
function normalizeToMeContext(rpcData: any): {
  user_id: string | null;
  email: string | null;
  tenant_id: string | null;
  roles: string[];
  active_role: string | null;
  active_role_source: string;
  ts: string;
} {
  return {
    user_id: rpcData?.user_id || rpcData?.id || null,
    email: rpcData?.email || null,
    tenant_id: rpcData?.tenant_id || null,
    roles: Array.isArray(rpcData?.roles)
      ? rpcData.roles
      : Array.isArray(rpcData?.available_roles)
        ? rpcData.available_roles
        : VALID_ROLES,
    active_role: rpcData?.active_role || null,
    active_role_source: 'supabase_rpc',
    ts: new Date().toISOString(),
  };
}

/**
 * VTID-01048: GET /
 * Returns the authoritative identity + role context for the current user.
 * This is the single source of truth for user_id + tenant + roles + active_role.
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "me": {
 *     "user_id": "uuid",
 *     "email": "string|null",
 *     "tenant_id": "string|null",
 *     "roles": ["community","patient","professional","staff","admin","developer"],
 *     "active_role": "admin",
 *     "active_role_source": "supabase_rpc",
 *     "ts": "iso"
 *   }
 * }
 *
 * Errors:
 * - 401: { ok: false, error: "UNAUTHENTICATED" }
 */
router.get('/', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01048] GET /me - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      console.error('[VTID-01048] GET /me - RPC error:', error.message);
      // Check if it's an auth error
      if (error.message.includes('JWT') || error.message.includes('auth') || error.code === 'PGRST301') {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHENTICATED',
        });
      }
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }

    console.log('[VTID-01048] GET /me - Success');
    return res.status(200).json({
      ok: true,
      me: normalizeToMeContext(data),
    });
  } catch (err: any) {
    console.error('[VTID-01048] GET /me - Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * GET /context
 * Returns the current user's context including tenant_id and active_role.
 * Calls Supabase RPC: me_context()
 *
 * Note: This is the legacy endpoint. VTID-01048 adds GET / as the canonical endpoint.
 */
router.get('/context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01046] GET /me/context - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'MISSING_BEARER_TOKEN',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      console.error('[VTID-01046] GET /me/context - RPC error:', error.message);
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }

    console.log('[VTID-01046] GET /me/context - Success');
    return res.status(200).json({
      ok: true,
      ...data,
    });
  } catch (err: any) {
    console.error('[VTID-01046] GET /me/context - Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/**
 * VTID-01048: POST /active-role
 * Persists a role change server-side.
 * Calls Supabase RPC: me_set_active_role(p_role)
 * Returns fresh me_context() in same response format as GET /api/v1/me.
 *
 * Request: { "role": "developer" }
 *
 * Response (200):
 * {
 *   "ok": true,
 *   "me": { ...same format as GET /api/v1/me... }
 * }
 *
 * Errors:
 * - 400 INVALID_ROLE
 * - 401 UNAUTHENTICATED
 * - 403 FORBIDDEN (if role not allowed for that user)
 */
router.post('/active-role', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01048] POST /me/active-role - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
  }

  const { role } = req.body;

  // Validate role is one of the allowed values
  if (!role || !VALID_ROLES.includes(role)) {
    console.warn('[VTID-01048] POST /me/active-role - Invalid role:', role);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_ROLE',
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    // Set the active role via RPC
    const { error: setError } = await supabase.rpc('me_set_active_role', { p_role: role });

    if (setError) {
      console.error('[VTID-01048] POST /me/active-role - RPC set error:', setError.message);

      // Check for authentication errors
      if (setError.message.includes('JWT') || setError.message.includes('auth') || setError.code === 'PGRST301') {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHENTICATED',
        });
      }

      // Check for forbidden/permission errors (role not allowed for user)
      if (setError.message.includes('forbidden') || setError.message.includes('permission') || setError.message.includes('not allowed')) {
        return res.status(403).json({
          ok: false,
          error: 'FORBIDDEN',
        });
      }

      return res.status(400).json({
        ok: false,
        error: setError.message,
      });
    }

    // Fetch fresh me_context after setting role
    const { data: contextData, error: contextError } = await supabase.rpc('me_context');

    if (contextError) {
      console.error('[VTID-01048] POST /me/active-role - RPC context error:', contextError.message);
      return res.status(400).json({
        ok: false,
        error: contextError.message,
      });
    }

    console.log('[VTID-01048] POST /me/active-role - Success, role set to:', role);
    return res.status(200).json({
      ok: true,
      me: normalizeToMeContext(contextData),
    });
  } catch (err: any) {
    console.error('[VTID-01048] POST /me/active-role - Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

export default router;
