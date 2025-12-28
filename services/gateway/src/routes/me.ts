import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();

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
 * GET /context
 * Returns the current user's context including tenant_id and active_role.
 * Calls Supabase RPC: me_context()
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
 * POST /active-role
 * Sets the user's active role for the current session.
 * Calls Supabase RPC: me_set_active_role(p_role)
 *
 * Body: { "role": "patient" | "community" | "professional" | "staff" | "admin" | "developer" }
 */
router.post('/active-role', async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    console.warn('[VTID-01046] POST /me/active-role - Missing bearer token');
    return res.status(401).json({
      ok: false,
      error: 'MISSING_BEARER_TOKEN',
    });
  }

  const { role } = req.body;
  const validRoles = ['patient', 'community', 'professional', 'staff', 'admin', 'developer'];

  if (!role || !validRoles.includes(role)) {
    console.warn('[VTID-01046] POST /me/active-role - Invalid role:', role);
    return res.status(400).json({
      ok: false,
      error: `Invalid role. Must be one of: ${validRoles.join(', ')}`,
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_set_active_role', { p_role: role });

    if (error) {
      console.error('[VTID-01046] POST /me/active-role - RPC error:', error.message);
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }

    console.log('[VTID-01046] POST /me/active-role - Success, role set to:', role);
    return res.status(200).json({
      ok: true,
      ...data,
    });
  } catch (err: any) {
    console.error('[VTID-01046] POST /me/active-role - Unexpected error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

export default router;
