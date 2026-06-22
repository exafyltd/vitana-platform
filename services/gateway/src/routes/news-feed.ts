/**
 * VTID-03319: News Feed — server-trusted endpoints.
 *
 * The unified "All News" feed is assembled client-side under RLS (member posts,
 * approved public videos, follows, matches, public news). The ONE read that
 * needs server-side trust is the consent-gated community spotlight: it crosses
 * user boundaries and reads the Vitana Index, neither of which a client may do.
 *
 *   GET /api/v1/news-feed/top-performer
 *     → { ok: true, performer: { user_id, display_name, avatar_url,
 *                                improvement, computed_at } | null }
 *
 * "Most improved", not "highest score": we rank by the per-user delta in
 * score_total over a trailing window, restricted to members who explicitly
 * opted in (profiles.index_spotlight_consent = true). Exact scores are never
 * returned — only the improvement delta. Degrades to `performer: null` whenever
 * data or consent is missing, so the feed simply omits the spotlight.
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';

const router = Router();
const VTID = 'VTID-03319';

// Trailing window over which "improvement" is measured.
const WINDOW_DAYS = 30;

interface ScoreRow {
  user_id: string;
  date: string;
  score_total: number;
}

router.get('/top-performer', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
    }

    const tenantId = req.identity?.tenant_id || null;

    // 1. Members who opted in to the spotlight.
    let consentQuery = supabase
      .from('profiles')
      .select('user_id, display_name, avatar_url')
      .eq('index_spotlight_consent', true);
    const { data: consented, error: consentErr } = await consentQuery;
    if (consentErr || !consented || consented.length === 0) {
      return res.json({ ok: true, vtid: VTID, performer: null });
    }
    const consentedIds = consented.map((p: any) => p.user_id);

    // 2. Index history for those members over the trailing window.
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    let scoresQuery = supabase
      .from('vitana_index_scores')
      .select('user_id, date, score_total')
      .in('user_id', consentedIds)
      .gte('date', since)
      .order('date', { ascending: true });
    if (tenantId) scoresQuery = scoresQuery.eq('tenant_id', tenantId);
    const { data: scores, error: scoresErr } = await scoresQuery;
    if (scoresErr || !scores || scores.length === 0) {
      return res.json({ ok: true, vtid: VTID, performer: null });
    }

    // 3. Per-user improvement = latest score - earliest score in the window.
    //    Needs at least two data points to be a real "improvement".
    const byUser = new Map<string, ScoreRow[]>();
    for (const row of scores as ScoreRow[]) {
      const arr = byUser.get(row.user_id) || [];
      arr.push(row);
      byUser.set(row.user_id, arr);
    }

    let best: { user_id: string; improvement: number } | null = null;
    for (const [userId, rows] of byUser) {
      if (rows.length < 2) continue; // rows are date-ascending from the query
      const improvement = rows[rows.length - 1].score_total - rows[0].score_total;
      if (improvement <= 0) continue;
      if (!best || improvement > best.improvement || (improvement === best.improvement && userId < best.user_id)) {
        best = { user_id: userId, improvement };
      }
    }

    if (!best) {
      return res.json({ ok: true, vtid: VTID, performer: null });
    }

    const profile = consented.find((p: any) => p.user_id === best!.user_id);
    return res.json({
      ok: true,
      vtid: VTID,
      performer: {
        user_id: best.user_id,
        display_name: profile?.display_name || null,
        avatar_url: profile?.avatar_url || null,
        improvement: best.improvement,
        computed_at: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    // Never break the feed — degrade to no spotlight.
    console.error(`[${VTID}] top-performer error:`, err?.message || err);
    return res.json({ ok: true, vtid: VTID, performer: null });
  }
});

export default router;
