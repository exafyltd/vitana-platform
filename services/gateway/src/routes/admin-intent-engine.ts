/**
 * VTID-01973: Admin Intent Engine (P2-A).
 *
 * exafy_admin only. Surface for moderation, manual recompute, archival.
 * P2-A baseline:
 *   GET   /api/v1/admin/intent-engine/intent/:id        — read any intent (bypasses visibility)
 *   POST  /api/v1/admin/intent-engine/intent/:id/close  — force close
 *   POST  /api/v1/admin/intent-engine/recompute         — body { intent_id? } — re-run compute (one or daily fan-out)
 *   GET   /api/v1/admin/intent-engine/stats             — basic dashboard counts
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  requireAdminAuth,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { computeForIntent } from '../services/intent-matcher';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

router.get('/intent/:id', requireAdminAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_intents')
    .select('*')
    .eq('intent_id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'not_found' });
  return res.json({ ok: true, intent: data });
});

router.post('/intent/:id/close', requireAdminAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_intents')
    .update({ status: 'closed' })
    .eq('intent_id', req.params.id);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  await supabase.from('intent_events').insert({
    intent_id: req.params.id,
    actor_user_id: identity?.user_id,
    actor_vitana_id: identity?.vitana_id ?? null,
    event_type: 'admin.force_close',
    payload: { reason: req.body?.reason ?? 'admin_action' },
  });
  return res.json({ ok: true });
});

router.post('/recompute', requireAdminAuth, async (req: Request, res: Response) => {
  const intentId = req.body?.intent_id as string | undefined;
  if (intentId) {
    const inserted = await computeForIntent(intentId);
    return res.json({ ok: true, mode: 'one', inserted });
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('compute_intent_matches_daily');
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, mode: 'daily', result: data });
});

router.get('/stats', requireAdminAuth, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  const { count: totalIntents } = await supabase
    .from('user_intents')
    .select('*', { count: 'exact', head: true });
  const { count: openIntents } = await supabase
    .from('user_intents')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'open');
  const { count: totalMatches } = await supabase
    .from('intent_matches')
    .select('*', { count: 'exact', head: true });
  const { count: stuckOpen } = await supabase
    .from('user_intents')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'open')
    .eq('match_count', 0)
    .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  return res.json({
    ok: true,
    stats: {
      total_intents: totalIntents ?? 0,
      open_intents: openIntents ?? 0,
      total_matches: totalMatches ?? 0,
      stuck_open_24h: stuckOpen ?? 0,
    },
  });
});

export default router;
