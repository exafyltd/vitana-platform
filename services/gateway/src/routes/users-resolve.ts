/**
 * VTID-01967: POST /api/v1/users/resolve
 *
 * Voice-resolver primitive. Given a spoken-name token, returns ranked
 * candidates from `resolve_recipient_candidates()` (peer-scoped to the
 * actor's tenant). The ORB voice tool `resolve_recipient` calls this; the
 * frontend MessageComposeModal also uses it as a typeahead source.
 *
 * Body: { token: string, limit?: number }
 * Returns: { candidates, top_confidence, ambiguous }
 *   ambiguous = top_confidence < 0.85 OR (second_score / top_score) > 0.85
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
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

const AMBIGUITY_THRESHOLD = 0.85; // top score must clear this; otherwise ask user
const TIE_RATIO_THRESHOLD = 0.85; // if second/first > this, it's a tie

router.post('/resolve', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { token, limit } = req.body ?? {};

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'token is required' });
  }

  const limitInt = Math.min(Math.max(Number(limit) || 5, 1), 20);

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('resolve_recipient_candidates', {
    p_actor: identity.user_id,
    p_token: token,
    p_limit: limitInt,
    p_global: false,
  });

  if (error) {
    console.error('[VTID-01967] users/resolve RPC error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  const candidates = (data || []) as Array<{
    user_id: string;
    vitana_id: string | null;
    display_name: string | null;
    avatar_url: string | null;
    score: number;
    reason: string;
  }>;

  const top_confidence = candidates.length > 0 ? Number(candidates[0].score) : 0;
  const ambiguous =
    candidates.length === 0 ||
    top_confidence < AMBIGUITY_THRESHOLD ||
    (candidates.length > 1 &&
      Number(candidates[1].score) / Math.max(top_confidence, 0.0001) > TIE_RATIO_THRESHOLD);

  return res.json({
    ok: true,
    candidates,
    top_confidence,
    ambiguous,
  });
});

export default router;
