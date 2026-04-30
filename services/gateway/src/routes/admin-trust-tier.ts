/**
 * VTID-DANCE-D6: Admin trust-tier flip endpoint.
 *
 * Manual upgrade path (community_verified / pro_verified / id_verified)
 * until Persona/Onfido SDK integration lands. Operator-only.
 *
 *   POST /api/v1/admin/users/:vitana_id/trust-tier  body: { tier, reason? }
 */

import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

const VALID_TIERS = new Set(['unverified', 'community_verified', 'pro_verified', 'id_verified']);

router.post('/admin/users/:vitana_id/trust-tier', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const isOperator = Boolean((identity as any).exafy_admin);
  if (!isOperator) {
    return res.status(403).json({ ok: false, error: 'OPERATOR_ONLY' });
  }

  const targetVid = String(req.params.vitana_id || '').trim().toLowerCase();
  if (!targetVid) return res.status(400).json({ ok: false, error: 'VITANA_ID_REQUIRED' });

  const { tier, reason } = (req.body ?? {}) as { tier?: string; reason?: string };
  if (!tier || !VALID_TIERS.has(tier)) {
    return res.status(400).json({ ok: false, error: 'INVALID_TIER', valid: Array.from(VALID_TIERS) });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_unavailable' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('user_id, vitana_id')
    .eq('vitana_id', targetVid)
    .maybeSingle();
  if (!profile) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });

  const userId = (profile as any).user_id as string;
  const provider = tier === 'id_verified' ? 'manual_admin' : null;

  // Upsert into user_reputation. The row may not exist yet for new users.
  const { error } = await supabase
    .from('user_reputation')
    .upsert(
      {
        vitana_id: targetVid,
        user_id: userId,
        trust_tier: tier,
        ...(tier === 'id_verified'
          ? { id_verified_at: new Date().toISOString(), id_verified_by: provider }
          : {}),
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: 'vitana_id' }
    );

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  await emitOasisEvent({
    vtid: 'VTID-DANCE-D6',
    type: 'vitana_id.confirmed', // closest existing event taxonomy
    source: 'admin-trust-tier',
    status: 'success',
    message: `Trust tier flip: @${targetVid} → ${tier}`,
    payload: {
      target_vitana_id: targetVid,
      target_user_id: userId,
      new_tier: tier,
      reason: reason || null,
    },
    actor_id: identity.user_id,
    actor_role: 'admin',
    surface: 'api',
    vitana_id: identity.vitana_id ?? undefined,
  });

  return res.json({ ok: true, vitana_id: targetVid, tier });
});

export default router;
