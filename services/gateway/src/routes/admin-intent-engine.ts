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

// ─── VTID-01976 (P2-C): disputes + KPI + archival + reconcile ───

router.get('/disputes', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { listOpenDisputes } = await import('../services/intent-dispute-service');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const disputes = await listOpenDisputes(limit);
    return res.json({ ok: true, disputes });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message ?? 'unknown' });
  }
});

router.get('/disputes/by-match/:matchId', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { listDisputesForMatch } = await import('../services/intent-dispute-service');
    const disputes = await listDisputesForMatch(req.params.matchId);
    return res.json({ ok: true, disputes });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message ?? 'unknown' });
  }
});

router.post('/disputes/:disputeId/resolve', requireAdminAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const status = String(req.body?.status ?? '').trim() as 'resolved' | 'dismissed';
  const resolution = String(req.body?.resolution ?? '').trim();
  if (!['resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'status must be resolved|dismissed' });
  }
  if (resolution.length < 5) {
    return res.status(400).json({ ok: false, error: 'resolution required (min 5 chars)' });
  }
  try {
    const { resolveDispute } = await import('../services/intent-dispute-service');
    const dispute = await resolveDispute({
      dispute_id: req.params.disputeId,
      actor_user_id: identity.user_id,
      actor_vitana_id: identity.vitana_id ?? null,
      status,
      resolution,
    });
    return res.json({ ok: true, dispute });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message ?? 'unknown' });
  }
});

// KPI route — feeds the Command Hub Intent Engine tile.
router.get('/kpi', requireAdminAuth, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [
      { count: posted24h },
      { count: posted7d },
      { count: matchedAny },
      { count: mutualInterest },
      { count: openDisputes },
      { count: stuckOpen },
      kindCounts,
    ] = await Promise.all([
      supabase.from('user_intents').select('*', { count: 'exact', head: true }).gte('created_at', since24h),
      supabase.from('user_intents').select('*', { count: 'exact', head: true }).gte('created_at', since7d),
      supabase.from('user_intents').select('*', { count: 'exact', head: true }).gt('match_count', 0),
      supabase.from('intent_matches').select('*', { count: 'exact', head: true }).eq('state', 'mutual_interest'),
      supabase.from('intent_disputes').select('*', { count: 'exact', head: true }).in('status', ['open', 'investigating']),
      supabase.from('user_intents').select('*', { count: 'exact', head: true })
        .eq('status', 'open')
        .eq('match_count', 0)
        .lt('created_at', since24h),
      supabase.from('user_intents').select('intent_kind').gte('created_at', since7d).limit(1000),
    ]);

    // Aggregate kinds breakdown.
    const kindBreakdown: Record<string, number> = {};
    for (const row of (kindCounts.data ?? []) as Array<{ intent_kind: string }>) {
      kindBreakdown[row.intent_kind] = (kindBreakdown[row.intent_kind] ?? 0) + 1;
    }

    return res.json({
      ok: true,
      kpi: {
        posted_24h: posted24h ?? 0,
        posted_7d: posted7d ?? 0,
        intents_with_match: matchedAny ?? 0,
        mutual_interest: mutualInterest ?? 0,
        open_disputes: openDisputes ?? 0,
        stuck_open_24h: stuckOpen ?? 0,
        kinds_7d: kindBreakdown,
        snapshot_at: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message ?? 'unknown' });
  }
});

// Archival trigger. Idempotent — invoke daily via Cloud Scheduler or manual.
router.post('/archive', requireAdminAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  const olderThan = Math.max(Number(req.body?.older_than_days) || 90, 7);
  const batchSize = Math.min(Math.max(Number(req.body?.batch_size) || 500, 1), 5000);
  try {
    const { data, error } = await supabase.rpc('archive_old_intent_matches', {
      p_older_than_days: olderThan,
      p_batch_size: batchSize,
    });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    const row = Array.isArray(data) ? data[0] : data;
    return res.json({ ok: true, archived: row?.archived ?? 0, remaining: row?.remaining ?? 0 });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message ?? 'unknown' });
  }
});

export default router;
