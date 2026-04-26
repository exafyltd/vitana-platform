/**
 * VTID-01967: GET /api/v1/admin/users/lookup
 *
 * Admin support tooling — global (cross-tenant) Vitana ID lookup. Voice
 * Lab, OASIS event panels, and Command Hub user-detail screens use this
 * to jump from "@alex3700" to a user's full profile + tenant + recent
 * activity without joining DBs by hand.
 *
 * Query: ?token=<vitana_id_or_handle_or_name>&limit=<n>
 * Auth:  exafy_admin = true (gateway role check; SQL function trusts the
 *        p_global flag forwarded from this route).
 */

import { Router, Request, Response } from 'express';
import {
  requireAdminAuth,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { createClient } from '@supabase/supabase-js';

const router = Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );
}

router.get('/users/lookup', requireAdminAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const token = (req.query.token as string | undefined)?.trim();
  const limitParam = req.query.limit;
  if (!token) {
    return res.status(400).json({ ok: false, error: 'token query parameter is required' });
  }

  const limitInt = Math.min(Math.max(Number(limitParam) || 10, 1), 50);

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('resolve_recipient_candidates', {
    p_actor: identity.user_id,
    p_token: token,
    p_limit: limitInt,
    p_global: true, // admin-only: cross-tenant search
  });

  if (error) {
    console.error('[VTID-01967] admin/users/lookup RPC error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({
    ok: true,
    candidates: data || [],
  });
});

export default router;
