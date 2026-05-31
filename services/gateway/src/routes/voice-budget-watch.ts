import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAdminAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { fetchVoiceBudgetWatch } from '../services/voice-budget-watch';

/**
 * Phase D (DEV-COMHU voice budget watch): admin observability for the Vertex
 * `system_instruction` budget. Surfaces the top-N users by memory-budget usage so the
 * team can prune / consolidate BEFORE a heavy user overflows Vertex setup and loses TTS.
 *
 * GET /api/v1/admin/voice-budget-watch?limit=50&min_pct=10
 *   → { ok, rows: VoiceBudgetRow[] }   (sorted by pct_of_cap desc)
 *
 * Admin-only via requireAdminAuth (exafy_admin). Read-only.
 */
const router = Router();

router.get('/voice-budget-watch', requireAdminAuth, async (req: Request, res: Response) => {
  const _auth = req as AuthenticatedRequest; // requireAdminAuth has validated identity
  void _auth;
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'supabase_unavailable' });
  }

  const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
  const minPct = Number.parseFloat(String(req.query.min_pct ?? '10'));

  try {
    const rows = await fetchVoiceBudgetWatch(supabase, {
      limit: Number.isFinite(limit) ? limit : 50,
      minPct: Number.isFinite(minPct) ? minPct : 10,
    });
    return res.json({ ok: true, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: 'voice_budget_watch_failed', message });
  }
});

export default router;
